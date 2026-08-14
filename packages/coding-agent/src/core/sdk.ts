import { join } from "node:path";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "apex-code-agent-core";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession, type AgentSessionConfig } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { AgentDefinitionResolver, DelegationRuntimeOptions } from "./delegation/runtime.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { DerivedPermissionRuleStore } from "./permissions/store.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import type { ApexToolDefinition, Capability } from "./tools/contract.ts";
import {
	createAllToolDefinitions,
	createBashTool,
	createCodingTools,
	createDelegateToolDefinition,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import pi-ai/compat itself.
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.apex-code/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, pi enables the default built-in tools (read, bash, edit, write)
	 * and leaves extension/custom tools enabled unless `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Authorization configuration for every registered tool call. */
	permissionGate?: AgentSessionConfig["permissionGate"];
	/**
	 * Delegation entry point (roadmap Phase 5, ADR 0008). When set, `delegate`
	 * executes real child sessions through `resolveAgent`, with the child's
	 * authority derived from this session's live active tools and permission
	 * store -- never reconstructed. When omitted, `delegate` stays inert (no agent
	 * types resolve). Agent discovery is injected here as a caller-supplied
	 * resolver rather than built in, until Phase 5 task 5.5 lands real
	 * markdown/frontmatter discovery. Requires `permissionGate` to be set too: a
	 * child's authority has nothing to derive from otherwise.
	 */
	delegation?: { resolveAgent: AgentDefinitionResolver };
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
/** The most recent assistant text in a completed session -- what a delegated child returns to its parent as its result. */
function extractFinalAssistantText(session: AgentSession): string {
	const messages = session.agent.state.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((content): content is Extract<AgentMessage, { role: "assistant" }>["content"][number] & { type: "text" } =>
				content.type === "text",
			)
			.map((content) => content.text)
			.join("\n");
		if (text) return text;
	}
	return "";
}

export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames: string[] = (
		options.tools ? [...options.tools] : options.noTools ? [] : defaultActiveToolNames
	).filter((name) => !excludedToolNameSet?.has(name));

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const headerRunner = extensionRunnerRef.current;
			return modelRuntime.streamSimple(model, context, {
				...options,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				transformHeaders: async (requestHeaders) => {
					const headers = mergeProviderAttributionHeaders(
						model,
						settingsManager,
						options?.sessionId,
						requestHeaders,
					);
					return headerRunner?.hasHandlers("before_provider_headers")
						? headerRunner.emitBeforeProviderHeaders(headers ?? {})
						: (headers ?? {});
				},
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	// Forward ref, mirroring extensionRunnerRef above: the delegation runtime's
	// closures are needed to build `customTools` before `session` exists, but they
	// must read the *live* session (active tools can change after construction),
	// not a snapshot frozen at this point.
	const parentSessionRef: { current?: AgentSession } = {};
	const customTools: ToolDefinition[] = options.customTools ? [...options.customTools] : [];
	if (options.delegation) {
		const parentPermissionGate = options.permissionGate;
		const delegationRuntime: DelegationRuntimeOptions = {
			resolveAgent: options.delegation.resolveAgent,
			getParentCapabilities: () => {
				const capabilities = new Set<Capability>();
				for (const name of parentSessionRef.current?.getActiveToolNames() ?? []) {
					const contract = (parentSessionRef.current?.getToolDefinition(name) as
						| Partial<ApexToolDefinition>
						| undefined)?.contract;
					if (contract) for (const capability of contract.capabilities) capabilities.add(capability);
				}
				return capabilities;
			},
			getToolCapabilities: (toolName) => {
				// Prefer the parent's own live registry first (it also covers
				// extension/custom tools an agent definition might name), but fall back
				// to the canonical built-in registry: "what capability does tool X
				// need" is a property of the tool itself, independent of whether the
				// parent's own session restricted it out of its active/allowed set via
				// `tools`/`excludeTools` -- that restriction affects the parent's own
				// *authority* (getParentCapabilities, above), not what a named tool is.
				const fromParent = (parentSessionRef.current?.getToolDefinition(toolName) as
					| Partial<ApexToolDefinition>
					| undefined)?.contract?.capabilities;
				if (fromParent) return fromParent;
				return (createAllToolDefinitions(cwd)[toolName as ToolName] as ApexToolDefinition | undefined)?.contract
					?.capabilities;
			},
			// Read fresh each call, not captured once: depth is a live property of
			// the (possibly delegated) session this createAgentSession call is
			// building, via the same sessionManager this closure already captures.
			getDelegationDepth: () => sessionManager.getDelegationDepth(),
			maxDelegationDepth: settingsManager.getDelegationMaxDepth(),
			buildChildSession: async ({ definition, toolNames, depth }) => {
				if (!parentPermissionGate) {
					throw new Error("delegate requires a permission gate configured on the parent session (ADR 0008).");
				}
				const childModel =
					(definition.model && modelRuntime.getAvailableSnapshot().find((m) => m.id === definition.model)) || model;
				if (!childModel) {
					throw new Error(`Cannot delegate to "${definition.name}": no model is available for the child session.`);
				}
				const childSessionManager = SessionManager.inMemory(cwd, {
					parentSession: sessionManager.getSessionId(),
					delegationDepth: depth,
				});
				const derivedStore = new DerivedPermissionRuleStore({ parent: parentPermissionGate.store });
				const { session: childSession } = await createAgentSession({
					cwd,
					agentDir,
					model: childModel,
					modelRuntime,
					settingsManager,
					sessionManager: childSessionManager,
					resourceLoader,
					tools: toolNames,
					// No responder: a child's `ask` fails closed rather than prompting the
					// human for a call the human did not make (ADR 0008, "Who answers a
					// child's ask").
					permissionGate: { store: derivedStore, getMode: parentPermissionGate.getMode },
					// Forwarded so a child that itself holds `delegate` can delegate again
					// (bounded by the depth guard above, read fresh from its own session
					// header on its next createAgentSession call) -- otherwise recursion
					// would be silently capped at one level regardless of maxDelegationDepth.
					delegation: options.delegation,
				});
				await childSession.bindExtensions({});
				return {
					async run(task: string) {
						const prompt = definition.systemPrompt ? `${definition.systemPrompt}\n\nTask: ${task}` : `Task: ${task}`;
						await childSession.prompt(prompt);
						return { output: extractFinalAssistantText(childSession) };
					},
					dispose() {
						childSession.dispose();
					},
				};
			},
		};
		customTools.push(createDelegateToolDefinition(delegationRuntime) as ToolDefinition<any, any>);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools,
		modelRuntime,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		permissionGate: options.permissionGate,
	});
	parentSessionRef.current = session;
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
