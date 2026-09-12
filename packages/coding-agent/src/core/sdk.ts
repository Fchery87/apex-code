import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import {
	Agent,
	type AgentMessage,
	type AgentRunBudgetController,
	type AgentStopReason,
	createRunBudgetController,
	setDefaultStreamFn,
	type ThinkingLevel,
} from "apex-code-agent-core";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession, type AgentSessionConfig, type AggregateBudgetUsageSnapshot } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { AuthStorage } from "./auth-storage.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { createAgentDefinitionResolver } from "./delegation/agents.ts";
import {
	type AgentDefinitionResolver,
	type ChildRunPolicySnapshot,
	ChildRunRegistry,
	type ChildTurnResult,
	type DelegationRuntimeOptions,
} from "./delegation/runtime.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { loadHookRuntime } from "./hooks/loader.ts";
import type { HookRuntime } from "./hooks/types.ts";
import { createSessionMcpConnector } from "./mcp/connector.ts";
import { createMcpRuntime } from "./mcp/runtime.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { DerivedPermissionRuleStore } from "./permissions/store.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { type ResolvedRunBudget, SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import { type BackgroundShellRegistry, createBackgroundShellRegistry } from "./tools/background-shell.ts";
import type { ApexToolDefinition, Capability, EvidenceSink } from "./tools/contract.ts";
import {
	createAllToolDefinitions,
	createBashTool,
	createCodingTools,
	createDelegateToolDefinition,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";
import { GitWorktreeWorkspaceOwner } from "./workspace/git-worktree-owner.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import pi-ai/compat itself.
setDefaultStreamFn(streamSimple);

export interface CreateAgentSessionOptions {
	childRunRegistry?: AgentSessionConfig["childRunRegistry"];
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
	 * When omitted, pi uses the `defaultTools` setting for the initial built-in
	 * selection when configured. Otherwise it enables the default built-in tools
	 * (read, bash, edit, write). Extension/custom tools remain enabled unless
	 * `noTools` changes that default. When provided, only the listed tool names are
	 * enabled.
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
	/**
	 * Per-run budget policy override (spec 2026-09-09-run-and-child-session-architecture.md,
	 * "Shared budgets"). When supplied, it replaces the settings read for this
	 * session's Agent construction; `settingsManager.getRunBudget()` stays the
	 * default. Per-run only: every session -- parent and child alike -- counts
	 * its own runs against this policy. It never creates a shared ceiling.
	 */
	runBudget?: ResolvedRunBudget;
	/**
	 * The root aggregate budget for this session's whole delegation tree (spec
	 * 2026-09-09, "Shared budgets"). Explicit opt-in: it is never derived from
	 * `runBudget`. When set, this session creates ONE aggregate controller and
	 * (a) composes it under its own Agent's controller, so the parent's own runs
	 * consume the aggregate while the local per-prompt scope is unchanged, and
	 * (b) hands THE SAME controller instance to every delegated child regardless
	 * of depth, so the whole tree -- grandchildren included -- shares one
	 * ceiling. Read it through `session.aggregateBudgetUsage()`. Absent: no
	 * shared ceiling anywhere -- every session keeps local-only budgets (the
	 * per-run policy is still inherited).
	 */
	aggregateBudget?: ResolvedRunBudget;
	/**
	 * Maximum simultaneously-active delegated children this session's delegation
	 * runtime admits (spec 2026-09-09, "Shared budgets"). Checked at child
	 * admission, BEFORE any child session is built; over the limit the admission
	 * throws an actionable error naming the limit. An admitted run holds one
	 * slot until terminal settlement (completed/failed/interrupted), close, or
	 * launch failure. `undefined` (default) is unlimited. Only meaningful when
	 * delegation is configured.
	 */
	maxConcurrentChildren?: number;
	/**
	 * Budget controller scope for this session's Agent. "prompt" (default;
	 * upstream semantics) starts a fresh controller at every prompt();
	 * "session" creates one controller at the first prompt/continue and reuses
	 * it, so a resumed or follow-up turn continues the same budget. Delegated
	 * children are built with "session" so their budget survives sendInput /
	 * follow-up / resume turns (spec 2026-09-09, "Shared budgets").
	 */
	budgetScope?: "prompt" | "session";
	/**
	 * A shared budget controller composed under this session's own controller
	 * (`createCompositeBudgetController`): every gate allows only if both
	 * allow, and only accepted attempts record to both. The caller owns
	 * the controller's lifetime; this session never resets it. This is how a
	 * delegated child receives its root's aggregate controller (spec 2026-09-09,
	 * "Shared budgets") -- sessions that are not delegated children normally
	 * pass `aggregateBudget` instead and leave this unset.
	 */
	sharedBudgetController?: AgentRunBudgetController;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Authorization configuration for every registered tool call. */
	permissionGate?: AgentSessionConfig["permissionGate"];
	/** Optional headless permission bridge (ACP, spec 2026-08-31-acp-adapter.md): consulted before the interactive TUI responder. */
	permissionResponderFactory?: AgentSessionConfig["permissionResponderFactory"];
	/** Pre-assembled declarative hooks. Absent by default; `createAgentSession` assembles them from the settings manager when not supplied. */
	hookRuntime?: HookRuntime;
	/** Background-shell registry. Absent by default; `createAgentSession` creates one and disposes it with the session. */
	backgroundShellRegistry?: BackgroundShellRegistry;
	/** Optional destination for source-level evidence; defaults to the durable session sink. */
	evidenceSink?: EvidenceSink;
	/** Optional post-mutation diagnostics injected into `edit`/`write` (LSP.4). */
	diagnosticsOperations?: AgentSessionConfig["diagnosticsOperations"];
	/** Optional `lsp` navigation tool transport (LSP.5); registers and activates `lsp` when present. */
	lspOperations?: AgentSessionConfig["lspOperations"];
	webSearchOperations?: AgentSessionConfig["webSearchOperations"];
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
	delegation?: { resolveAgent?: AgentDefinitionResolver };
	/**
	 * Credential store the MCP OAuth connector uses (spec 2026-09-01-mcp-oauth).
	 * Default: the host AuthStorage, the same fallback the model runtime applies.
	 */
	mcpCredentials?: CredentialStore;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/**
	 * The session's delegation runtime options when delegation is configured
	 * (undefined otherwise). Exposing the one runtime the `delegate` tool uses
	 * lets external lifecycle callers (tests) launch
	 * children through the same authority derivation instead of re-deriving it.
	 */
	delegationRuntime?: DelegationRuntimeOptions;
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
	createPowerShellTool,
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
			.filter(
				(content): content is Extract<AgentMessage, { role: "assistant" }>["content"][number] & { type: "text" } =>
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
	const backgroundShellRegistry = options.backgroundShellRegistry ?? createBackgroundShellRegistry();
	// One resolved per-run budget policy: the caller's override when supplied,
	// else the settings policy. Children built below inherit this resolved value
	// so a child run carries the same per-run policy as its parent without
	// re-reading settings (spec 2026-09-09, "Shared budgets"). Per-run only: it
	// never creates a shared ceiling.
	const runBudget = options.runBudget ?? settingsManager.getRunBudget();
	// The root aggregate budget (spec 2026-09-09, "Shared budgets"): created
	// ONLY when the caller explicitly configures `aggregateBudget` -- never
	// derived from the per-run policy. One controller per root tree: the
	// parent's own Agent consumes it (composed under its per-prompt controller),
	// and buildChildSession forwards THE SAME instance to every child regardless
	// of depth, so a grandchild's consumption lands on the root ledger. Its wall
	// time starts here, at root session construction, and no descendant can
	// reset it: descendants only consume.
	const aggregateBudgetController = options.aggregateBudget
		? createRunBudgetController(options.aggregateBudget)
		: undefined;
	// The shared ceiling this session consumes and hands to its delegated
	// children: the root aggregate when configured, else a caller-supplied
	// controller (which is how a delegated child receives its root's aggregate).
	// With neither there is NO shared controller at all: every session keeps
	// local-only budgets under its inherited per-run policy.
	const sharedBudgetController = aggregateBudgetController ?? options.sharedBudgetController;
	// The tree-facing usage snapshot: the aggregate controller's counters cover
	// every accepted provider request, tool call, and maintenance request of the
	// parent's own runs and of every descendant, so one read reports the tree.
	const aggregateBudgetUsage = sharedBudgetController
		? (): AggregateBudgetUsageSnapshot => {
				const usage = sharedBudgetController.usage();
				return {
					providerRequests: usage.providerRequests,
					toolCalls: usage.toolCalls,
					maintenanceRequests: usage.maintenanceRequests,
					startedAtMs: usage.startedAt,
				};
			}
		: undefined;

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
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
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

	// Fall back to per-model override, then global default
	if (thinkingLevel === undefined && model) {
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			thinkingLevel = perModel;
		}
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	// OAuth-capable MCP servers resolve tokens through the session's own credential
	// seam: direct and lock-serialized, fail-closed when no store applies
	// (spec 2026-09-01-mcp-oauth). Servers without `auth: "oauth"` never touch it.
	const mcpRuntime = createMcpRuntime(
		cwd,
		createSessionMcpConnector({
			credentials: options.mcpCredentials ?? AuthStorage.create(authPath),
		}),
		{ projectTrusted: settingsManager.isProjectTrusted() },
	);

	// `web_search`, `lsp`, and `mcp` join the core four only when configured. All stay
	// registered either way, so an explicit `--tools` selection still reaches them and an
	// unconfigured call still explains itself. Activating an unconfigured tool would put a
	// name in the prompt that can only ever fail.
	const defaultActiveToolNames: string[] = [
		...(["read", "bash", "edit", "write"] satisfies ToolName[]),
		...(options.lspOperations ? ["lsp"] : []),
		...(options.webSearchOperations ? (["web_search"] satisfies ToolName[]) : []),
		...(mcpRuntime ? ["mcp"] : []),
	];
	const configuredDefaultToolNames = settingsManager.getDefaultTools();
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames = (
		options.tools ?? (options.noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames))
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
		// The resolved budget policy from above (override or settings); every
		// execution mode (interactive, print, JSON, RPC, ACP, SDK) runs through
		// this session, so none counts on its own
		// (spec 2026-09-01-tool-reliability-and-execution-budgets.md).
		runBudget,
		budgetScope: options.budgetScope ?? "prompt",
		// The root aggregate when configured (the parent's own runs consume it,
		// per-prompt local scope unchanged), else a caller-supplied shared
		// controller, else nothing (spec 2026-09-09, "Shared budgets").
		sharedBudgetController,
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
	const childRunRegistry = options.childRunRegistry ?? new ChildRunRegistry();
	const customTools: ToolDefinition[] = options.customTools ? [...options.customTools] : [];
	// A configured permission gate supplies the authority a child must derive, so
	// discovery is enabled by default in real sessions. Callers that need fixture
	// definitions may still provide an explicit resolver.
	const delegation = options.delegation ?? (options.permissionGate ? {} : undefined);
	let delegationRuntime: DelegationRuntimeOptions | undefined;
	if (delegation) {
		const parentPermissionGate = options.permissionGate;
		const resolveAgent =
			delegation.resolveAgent ??
			createAgentDefinitionResolver({
				cwd,
				agentDir,
				isProjectTrusted: () => settingsManager.isProjectTrusted(),
			});
		let worktreeOwner: GitWorktreeWorkspaceOwner | undefined;
		// One read of the delegation bound for this runtime; the policy snapshot
		// below reports the same value it enforces instead of re-reading settings.
		const delegationMaxDepth = settingsManager.getDelegationMaxDepth();
		delegationRuntime = {
			childRunRegistry,
			resolveAgent,
			// Concurrency cap (spec 2026-09-09, "Shared budgets"): the registry's
			// admission path reads it from the runtime options. Undefined is
			// unlimited.
			maxConcurrentChildren: options.maxConcurrentChildren,
			getParentCapabilities: () => {
				const capabilities = new Set<Capability>();
				for (const name of parentSessionRef.current?.getActiveToolNames() ?? []) {
					const contract = (
						parentSessionRef.current?.getToolDefinition(name) as Partial<ApexToolDefinition> | undefined
					)?.contract;
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
				const fromParent = (
					parentSessionRef.current?.getToolDefinition(toolName) as Partial<ApexToolDefinition> | undefined
				)?.contract?.capabilities;
				if (fromParent) return fromParent;
				return (createAllToolDefinitions(cwd)[toolName as ToolName] as ApexToolDefinition | undefined)?.contract
					?.capabilities;
			},
			// Read fresh each call, not captured once: depth is a live property of
			// the (possibly delegated) session this createAgentSession call is
			// building, via the same sessionManager this closure already captures.
			getDelegationDepth: () => sessionManager.getDelegationDepth(),
			maxDelegationDepth: delegationMaxDepth,
			getParentSessionDir: () => sessionManager.getSessionDir(),
			// Child-run records carry the parent session id so durable records and
			// protocol payloads tie each child to this session's own identity.
			getParentSessionId: () => sessionManager.getSessionId(),
			// Worktree isolation (spec 2026-09-09, "Parallel work and ownership"):
			// the production workspace owner, constructed on the first worktree-
			// isolated delegation only. Shared-read delegations never read this
			// property (the runtime consults the owner only for isolation
			// "worktree"), so they never construct an owner and never invoke git.
			get workspaceOwner() {
				if (worktreeOwner === undefined) {
					worktreeOwner = new GitWorktreeWorkspaceOwner(cwd);
				}
				return worktreeOwner;
			},
			buildChildSession: async ({
				definition,
				toolNames,
				capabilities,
				depth,
				sessionId,
				artifactDir,
				workspace,
				reattachSessionPath,
				timeoutMs,
			}) => {
				if (!parentPermissionGate) {
					throw new Error("delegate requires a permission gate configured on the parent session (ADR 0008).");
				}
				const childModel =
					(definition.model && modelRuntime.getAvailableSnapshot().find((m) => m.id === definition.model)) ||
					model;
				if (!childModel) {
					throw new Error(`Cannot delegate to "${definition.name}": no model is available for the child session.`);
				}
				// The derived policy snapshot (spec 2026-09-09, "Derive, do not
				// reconstruct"): the exact values this construction used -- the
				// ceiling-checked tool allowlist, the admitted capability set from
				// the runtime's single admission projection (never a second
				// classification, ADR 0010), the delegation bound it enforces, the
				// child's model, and the budget wiring every child is built with
				// (session-scoped own controller; aggregate only when a shared ceiling
				// was configured at the root). It rides on the returned handle so the
				// registry persists it on the child-run record.
				const policy: ChildRunPolicySnapshot = {
					tools: [...toolNames],
					capabilities: [...capabilities].sort(),
					sandbox: "none",
					maxDelegationDepth: delegationMaxDepth,
					model: childModel.id,
					budgetScope: "session",
					aggregateBudget: sharedBudgetController !== undefined,
				};
				// An isolated child runs inside the workspace owner's prepared root
				// (its linked worktree); a shared child keeps this session's cwd.
				const childCwd = workspace?.root ?? cwd;
				// The one reattachment seam (restart reconstruction): when the request
				// carries the existing child session path, that transcript is OPENED
				// rather than created; identity (header id, parentSession, depth) comes
				// from the file's own header. Every other input below is derived
				// exactly as for a fresh delegation -- permission store, model, tools,
				// budget -- so there is no second construction path.
				const childSessionManager = reattachSessionPath
					? SessionManager.open(reattachSessionPath, artifactDir)
					: artifactDir
						? SessionManager.create(childCwd, artifactDir, {
								id: sessionId,
								parentSession: sessionManager.getSessionId(),
								delegationDepth: depth,
							})
						: SessionManager.inMemory(childCwd, {
								parentSession: sessionManager.getSessionId(),
								delegationDepth: depth,
							});
				const derivedStore = new DerivedPermissionRuleStore({ parent: parentPermissionGate.store });
				const { session: childSession } = await createAgentSession({
					cwd: childCwd,
					agentDir,
					model: childModel,
					modelRuntime,
					settingsManager,
					// The parent's already-resolved per-run budget (override or settings),
					// not a fresh settings read: every child run carries the same per-run
					// policy as its parent (spec 2026-09-09, "Shared budgets").
					//
					// Session scope + the root aggregate: a resumed or follow-up child
					// turn continues the same child budget (one controller per child
					// Agent, created at its first turn), and every gate also answers
					// to the tree's shared ceiling -- accepted consumption records to
					// both the child's own controller and the aggregate. THE SAME
					// aggregate instance reaches every descendant regardless of
					// depth (a grandchild's parent forwards it onward), so there is
					// exactly ONE aggregate per root tree and no child can reset it
					// by resuming or spawning children (spec 2026-09-09, "Shared
					// budgets"). Without an aggregate there is no shared controller:
					// the child keeps local-only budgets under the inherited policy.
					//
					// A launch timeout (spec 2026-09-09, timeouts) overrides the
					// child's OWN wall-time limit with the requested timeoutMs, so the
					// existing AgentRunBudget wall-time gate enforces it mid-run; the
					// parent policy's other limits still apply unchanged.
					runBudget: timeoutMs === undefined ? runBudget : { ...runBudget, maxWallTimeMs: timeoutMs },
					budgetScope: "session",
					sharedBudgetController,
					// The same per-parent admission cap applies to a child's own
					// delegations (each runtime counts its direct children).
					maxConcurrentChildren: options.maxConcurrentChildren,
					sessionManager: childSessionManager,
					resourceLoader,
					tools: toolNames,
					// No responder: a child's `ask` fails closed rather than prompting the
					// human for a call the human did not make (ADR 0008, "Who answers a
					// child's ask").
					permissionGate: { store: derivedStore, getMode: parentPermissionGate.getMode },
					// A delegated child shares the parent's cwd-bound LSP pool (spec, "no
					// multi-root LSP connection and no sharing across cwd-bound service
					// lifetimes" -- delegated children are the one sharing exception).
					diagnosticsOperations: options.diagnosticsOperations,
					lspOperations: options.lspOperations,
					// Shared for the same reason as the LSP pool: the backend was resolved
					// once (possibly by running a shell command for the key) and a child
					// that re-resolved nothing would hold a `web_search` that only throws.
					webSearchOperations: options.webSearchOperations,
					// `checkpointSettings` is deliberately *not* forwarded. A child shares the
					// parent's cwd, so it would write refs under its own session id into the
					// same repository and interleave them with the parent's. The parent's
					// per-turn capture already covers everything a child does inside that turn.

					// Forwarded so a child that itself holds `delegate` can delegate again
					// (bounded by the depth guard above, read fresh from its own session
					// header on its next createAgentSession call) -- otherwise recursion
					// would be silently capped at one level regardless of maxDelegationDepth.
					delegation,
				});
				await childSession.bindExtensions({});
				let status: import("./delegation/runtime.ts").ChildSessionStatus = "idle";
				let runPromise: Promise<void> | undefined;
				let lastTurnResult: ChildTurnResult | undefined;
				// The captured structured terminal outcome of the run in flight
				// (`agent_end`'s stopReason). Budget refusals emit agent_end without
				// an assistant message, so this is the only way the settlement below
				// can see and name them.
				let runStopReason: AgentStopReason | undefined;
				const ensureOpen = () => {
					if (status === "closed") throw new Error("Child session is closed.");
				};
				const start = (input: string): Promise<void> => {
					ensureOpen();
					if (runPromise) throw new Error("Child session is already running.");
					status = "running";
					runStopReason = undefined;
					// Capture the run's structured terminal outcome: a budget refusal
					// emits agent_end without producing an assistant message, so the
					// message-based checks below cannot see it.
					const unsubscribeStop = childSession.subscribe((event) => {
						if (event.type === "agent_end") runStopReason = event.stopReason;
					});
					const pending = childSession
						.prompt(input)
						.then(
							() => {
								unsubscribeStop();
								if (status === "closed") {
									lastTurnResult = { outcome: "failed", output: "" };
									throw new Error("Child session is closed.");
								}
								if (status === "interrupted") {
									lastTurnResult = { outcome: "interrupted", output: extractFinalAssistantText(childSession) };
									throw new Error("Child session is interrupted.");
								}
								const lastAssistant = [...childSession.agent.state.messages]
									.reverse()
									.find((message) => message.role === "assistant");
								if (
									lastAssistant?.role === "assistant" &&
									(lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "error")
								) {
									status = "interrupted";
									lastTurnResult = {
										outcome: lastAssistant.stopReason === "aborted" ? "interrupted" : "failed",
										output: lastAssistant.errorMessage || extractFinalAssistantText(childSession),
									};
									throw new Error(lastAssistant.errorMessage || "Child session was interrupted.");
								}
								status = "idle";
								lastTurnResult = { outcome: "completed", output: extractFinalAssistantText(childSession) };
							},
							(error) => {
								unsubscribeStop();
								if (status !== "closed") status = "interrupted";
								lastTurnResult =
									status === "closed"
										? { outcome: "failed", output: "" }
										: { outcome: "interrupted", output: extractFinalAssistantText(childSession) };
								throw error;
							},
						)
						.finally(() => {
							runPromise = undefined;
						});
					runPromise = pending;
					return pending;
				};
				const sendInput = (input: string) => {
					ensureOpen();
					if (runPromise) {
						if (status !== "running") throw new Error("Child session is still stopping.");
						// A follow-up queued onto a live run settles through that run's
						// own loop; only turns that settle here pass through the gate.
						return childSession.followUp(input);
					}
					return start(input).then(() => requireVerifiedTurn());
				};
				const close = () => {
					if (status === "closed") return;
					status = "closed";
					childSession.dispose();
				};
				// Verification gate (spec 2026-09-09, "Verification at completion"):
				// a child with configured verification policies may not settle a turn
				// as successful unless the session's canonical tracker reports
				// "verified". The tracker is the only verifier; no child-local one is
				// introduced. With the "explicit" boundary the gate runs
				// requestVerification once here; with the "post-turn" boundary the
				// session already ran verification at its own turn boundary, so the
				// gate only reads the status. Any other completion status --
				// failed/unavailable/interrupted/continued-unverified -- fails the
				// turn with the status named in the error.
				const requireVerifiedTurn = async (): Promise<void> => {
					const policyIds = childSession.verificationPolicyIds();
					if (policyIds.length === 0) return;
					const verificationStatus =
						childSession.verificationBoundary() === "explicit"
							? await childSession.requestVerification()
							: childSession.verificationStatus();
					if (verificationStatus === "verified") return;
					const message = `Child verification failed: ${verificationStatus} (policies: ${policyIds.join(", ")}).`;
					lastTurnResult = { outcome: "failed", output: message };
					throw new Error(message);
				};
				return {
					get status() {
						return status;
					},
					latestResult: () => lastTurnResult,
					usage: () => childSession.agent.budgetUsage(),
					// The usage-rollup seam (spec 2026-09-09): the registry reads the
					// child's own transcript file when one exists, and falls back to
					// these in-memory entries only for a child that never persisted a
					// transcript. Read-only; the child's SessionManager stays the owner.
					sessionEntries: () => childSessionManager.getEntries(),
					async run(task: string) {
						const prompt = definition.systemPrompt
							? `${definition.systemPrompt}\n\nTask: ${task}`
							: `Task: ${task}`;
						await start(prompt);
						if (status === "closed" || status === "interrupted") throw new Error(`Child session is ${status}.`);
						// The launch timeout's settlement error path (spec 2026-09-09,
						// timeouts): a run refused at the child's own wall-time gate never
						// started meaningful work, so the delegation settles failed with
						// the exhausted limit named, reusing the budget's existing
						// exhaustedLimit vocabulary. Other budget refusals keep their
						// existing semantics (the refusal is named in the child transcript
						// and the prior result stands).
						if (runStopReason?.kind === "budget-exhausted" && runStopReason.limit === "wall-time") {
							const message = `Child run stopped before completing: the run's ${runStopReason.limit} budget was exhausted.`;
							lastTurnResult = { outcome: "failed", output: message };
							throw new Error(message);
						}
						// Delegated work cannot claim success when the child has a
						// required verification boundary and verification did not pass.
						// Use the session's canonical tracker rather than introducing
						// a second child-only verifier.
						await requireVerifiedTurn();
						return { output: extractFinalAssistantText(childSession) };
					},
					wait: async () => {
						while (runPromise) await runPromise;
					},
					interrupt: () => {
						ensureOpen();
						if (status === "running") {
							status = "interrupted";
							void childSession.abort().catch(() => undefined);
						}
					},
					close,
					sendInput,
					followUp: sendInput,
					dispose: close,
					// Construction linkage (spec 2026-09-09, policy/artifact
					// linkage): the registry relays these onto the persisted child_run
					// record and every status/wait payload derived from it.
					policy,
				};
			},
		};
		customTools.push(createDelegateToolDefinition(delegationRuntime) as ToolDefinition<any, any>);
		// Historical resume (restart reconstruction) reattaches a persisted child
		// through THIS runtime's buildChildSession seam. Wiring it here -- not only
		// at the first delegation -- is what makes resume work on a freshly
		// reopened session before any new delegation has run.
		childRunRegistry.setRuntimeOptions(delegationRuntime);
	}

	const session = new AgentSession({
		childRunRegistry,
		delegationRuntime,
		agent,
		// Root aggregate usage (spec 2026-09-09, "Shared budgets"): undefined
		// when the tree has no aggregate budget.
		aggregateBudgetUsage,
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
		permissionResponderFactory: options.permissionResponderFactory,
		evidenceSink: options.evidenceSink,
		diagnosticsOperations: options.diagnosticsOperations,
		lspOperations: options.lspOperations,
		webSearchOperations: options.webSearchOperations,
		mcpRuntime,
		checkpointSettings: settingsManager.getCheckpointSettings(),
		// Declarative hooks (spec 2026-08-31-declarative-hooks): assembled from the
		// merged settings -- project-scope entries only appear once trusted. A
		// malformed hooks key throws here, failing closed at wiring. Deliberately
		// not forwarded to delegation children (see the spec's boundary note).
		hookRuntime: options.hookRuntime ?? loadHookRuntime(settingsManager.getHookSettings()),
		backgroundShellRegistry,
	});
	parentSessionRef.current = session;
	// Eager servers connect here rather than on first use, so their tools are in the
	// cache before the model's first search. Detached: a slow or broken server delays
	// nothing, and `warmEagerServers` already swallows its own failures.
	void mcpRuntime?.warm();
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		delegationRuntime,
		modelFallbackMessage,
	};
}
