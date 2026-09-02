import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentTool } from "apex-code-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

/**
 * Session wiring for the run budget (TR.5, spec
 * 2026-09-01-tool-reliability-and-execution-budgets.md). One normalized policy
 * flows from settings through `createAgentSession` into agent-core; every
 * execution mode runs on this session, so none counts on its own. The
 * enforcement test below is the missing-wire test: without the sdk.ts wire it
 * runs unbounded and fails.
 */

const directories: string[] = [];

function scratch(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-run-budget-wiring-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createScriptedModel(): Model<"openai-completions"> {
	return {
		id: "budget-model",
		name: "Budget Model",
		api: "openai-completions",
		provider: "budget-provider",
		baseUrl: "https://budget.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function toolUseMessage(callIndex: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${callIndex}`, name: "probe", arguments: {} }],
		api: "openai-completions",
		provider: "budget-provider",
		model: "budget-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function doneMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-completions",
		provider: "budget-provider",
		model: "budget-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function countingProbeTool(executed: string[]): AgentTool<any> {
	return {
		name: "probe",
		label: "probe",
		description: "budget fixture tool",
		parameters: Type.Object({}),
		execute: async () => {
			executed.push(`call-${executed.length + 1}`);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
}

describe("run budget session wiring", () => {
	it("resolves the measured default policy onto the session's agent", async () => {
		const agentDir = scratch();
		const model = createScriptedModel();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory({});

		const cwd = join(agentDir, "project");
		mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});

		try {
			expect(session.agent.runBudget).toEqual({
				maxProviderRequests: 200,
				maxToolCalls: 2000,
				maxWallTimeMs: undefined,
			});
		} finally {
			session.dispose();
		}
	});

	it("enforces one shared policy through the session and reports the structured stop reason", async () => {
		const agentDir = scratch();
		const model = createScriptedModel();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory({ runBudget: { maxProviderRequests: 2 } });

		let providerRequests = 0;
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: () => {
				providerRequests++;
				const stream = createAssistantMessageEventStream();
				stream.end(toolUseMessage(providerRequests));
				return stream;
			},
		});

		const executed: string[] = [];
		const stopReasons: unknown[] = [];
		const cwd = join(agentDir, "project");
		mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});
		session.agent.state.tools = [countingProbeTool(executed)];
		session.agent.subscribe((event: AgentEvent) => {
			if (event.type === "agent_end") stopReasons.push(event.stopReason);
		});

		try {
			await session.prompt("keep calling the probe tool");

			expect(providerRequests).toBe(2);
			expect(executed).toEqual(["call-1", "call-2"]);
			expect(stopReasons.at(-1)).toEqual({ kind: "budget-exhausted", limit: "provider-requests" });
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});

	it("lets explicit unlimited settings run the same session unbounded", async () => {
		const agentDir = scratch();
		const model = createScriptedModel();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory({
			runBudget: { maxProviderRequests: "unlimited", maxToolCalls: "unlimited" },
		});

		let providerRequests = 0;
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: () => {
				providerRequests++;
				const stream = createAssistantMessageEventStream();
				stream.end(providerRequests < 4 ? toolUseMessage(providerRequests) : doneMessage());
				return stream;
			},
		});

		const executed: string[] = [];
		const stopReasons: unknown[] = [];
		const cwd = join(agentDir, "project");
		mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
		});
		session.agent.state.tools = [countingProbeTool(executed)];
		session.agent.subscribe((event: AgentEvent) => {
			if (event.type === "agent_end") stopReasons.push(event.stopReason);
		});

		try {
			await session.prompt("keep calling the probe tool");

			expect(providerRequests).toBe(4);
			expect(stopReasons.at(-1)).toEqual({ kind: "completed" });
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	});
});
