import { createInMemoryModelRegistry, createModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	FauxModelDefinition,
	FauxProviderRegistration,
	FauxResponseStep,
	Model,
} from "@earendil-works/pi-ai/compat";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import type { AgentMessage, AgentTool } from "apex-code-agent-core";
import { Agent } from "apex-code-agent-core";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionRunner } from "../../src/core/extensions/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import type { PermissionGateOptions } from "../../src/core/permissions/gate.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { InlineExtension, ResourceLoader } from "../../src/index.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.ts";

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

export interface HarnessOptions {
	models?: FauxModelDefinition[];
	settings?: Partial<Settings>;
	systemPrompt?: string;
	tools?: AgentTool[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<InlineExtension | CreateTestExtensionsResultInput>;
	permissionGate?: Omit<PermissionGateOptions, "getContract">;
	shouldStopAfterTurn?: Agent["shouldStopAfterTurn"];
	withConfiguredAuth?: boolean;
	modelsJson?: Record<string, unknown>;
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => void;
}

/**
 * Provider credentials that the model registry reads straight from the environment.
 *
 * A suite harness registers exactly one faux provider and every assertion about the
 * model surface assumes that is the only configured one. A developer with real
 * credentials exported breaks that assumption without touching the repo: the registry
 * counts their provider as configured too, and anything that renders or counts
 * providers behaves differently on their machine than in CI. `7209` failed exactly
 * this way, opening the model selector on a provider-selection step because a
 * `GEMINI_API_KEY` in the shell made `google` a second configured provider.
 *
 * Matching a suffix rather than listing every variable: the goal is that no ambient
 * credential reaches a suite test, and a new provider's key should be covered the day
 * it is added rather than the day someone remembers this list.
 *
 * The suffixes and the explicit names together cover every source
 * `getEnvApiKey` (`packages/ai/src/env-api-keys.ts`) consults: `_TOKEN` absorbs the
 * `*_AUTH_TOKEN`/`*_OAUTH_TOKEN` shapes as well as `HF_TOKEN` and
 * `COPILOT_GITHUB_TOKEN`, while the Bedrock container/web-identity variables and the
 * Vertex ADC trio are full names because their shapes share no suffix. When upstream
 * adds a provider credential variable that fits neither, it belongs in this list --
 * `test/suite/harness-credential-isolation.test.ts` pins the current coverage.
 */
const AMBIENT_CREDENTIAL_SUFFIXES = ["_API_KEY", "_TOKEN", "_BASE_URL"];
const AMBIENT_CREDENTIAL_NAMES = [
	"AWS_ACCESS_KEY_ID",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_GATEWAY_ID",
	"COPILOT_GITHUB_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
];

/** Remove ambient provider credentials, returning a restore function for `cleanup`. */
function isolateAmbientCredentials(): () => void {
	const saved = new Map<string, string>();
	for (const [name, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		const ambient =
			AMBIENT_CREDENTIAL_NAMES.includes(name) || AMBIENT_CREDENTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
		if (!ambient) continue;
		saved.set(name, value);
		delete process.env[name];
	}
	return () => {
		for (const [name, value] of saved) process.env[name] = value;
	};
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const restoreAmbientCredentials = isolateAmbientCredentials();
	const tempDir = createTempDir();
	const fauxProvider: FauxProviderRegistration = registerFauxProvider({
		models: options.models,
	});
	fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory(options.settings);

	const authStorage = AuthStorage.inMemory();
	if (withConfiguredAuth) {
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	}
	const modelsPath = options.modelsJson === undefined ? undefined : join(tempDir, "models.json");
	if (modelsPath) writeFileSync(modelsPath, JSON.stringify(options.modelsJson));
	const modelRegistry = modelsPath
		? await createModelRegistry(authStorage, modelsPath)
		: await createInMemoryModelRegistry(authStorage);
	if (withConfiguredAuth) {
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	}

	const agent = new Agent({
		getApiKey: () => (withConfiguredAuth ? "faux-key" : undefined),
		streamFn: streamSimple,
		shouldStopAfterTurn: options.shouldStopAfterTurn,
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a test assistant.",
			tools: [],
		},
		convertToLlm,
		onPayload: async (payload) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response) => {
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
		transformContext: async (messages: AgentMessage[]) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
	});
	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	const resourceLoader =
		options.resourceLoader ?? createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
		baseToolsOverride: toolMap,
		initialActiveToolNames: options.initialActiveToolNames,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
		extensionRunnerRef,
		permissionGate: options.permissionGate,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		sessionManager,
		settingsManager,
		authStorage,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		cleanup() {
			restoreAmbientCredentials();
			session.dispose();
			fauxProvider.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}
