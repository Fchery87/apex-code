import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "apex-code-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ApexToolDefinition } from "../../src/core/tools/contract.ts";
import { UNCLASSIFIED } from "../../src/core/tools/contract.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createFauxStreamFn, fauxModel } from "../test-harness.ts";
import { createTestResourceLoader } from "../utilities.ts";

const SECRET_ARGUMENT = "secretArgument";

function createDeferredTool(onCall: (value: string) => void): ApexToolDefinition {
	return {
		name: "secret_tool",
		label: "Secret tool",
		description: "Use after loading its parameter schema.",
		parameters: Type.Object({ [SECRET_ARGUMENT]: Type.String() }),
		execute: async (_id, params: { secretArgument: string }) => {
			onCall(params.secretArgument);
			return { content: [{ type: "text", text: "secret completed" }], details: {} };
		},
		contract: {
			...UNCLASSIFIED,
			context: { resultRecoverable: false, deferSchema: true },
		},
	};
}

describe("deferred schema load path (task 4.1)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `apex-schema-load-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("announces a deferred tool, loads its schema, and then executes a valid call on the next request", async () => {
		const { streamFn, state: faux } = createFauxStreamFn([
			{ toolCalls: [{ name: "tool_schema", args: { name: "secret_tool" } }] },
			{ toolCalls: [{ name: "secret_tool", args: { [SECRET_ARGUMENT]: "approved-value" } }] },
			"done",
		]);
		const model = fauxModel;
		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: { model, systemPrompt: "test", tools: [] },
			streamFn,
		});
		const authStorage = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "faux-key" } });
		const registry = await createInMemoryModelRegistry(authStorage);
		registry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			}],
		});

		let executedValue: string | undefined;
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRuntime: getModelRuntime(registry),
			resourceLoader: createTestResourceLoader(),
			customTools: [createDeferredTool((value) => {
				executedValue = value;
			})],
			initialActiveToolNames: ["secret_tool", "tool_schema"],
		});

		await session.prompt("load and use the secret tool");
		await session.agent.waitForIdle();

		expect(executedValue).toBe("approved-value");
		expect(faux.callCount).toBe(3);

		const firstSecret = faux.contexts[0]?.tools?.find((tool) => tool.name === "secret_tool");
		expect(JSON.stringify(firstSecret?.parameters)).not.toContain(SECRET_ARGUMENT);

		const firstSchemaTool = faux.contexts[0]?.tools?.find((tool) => tool.name === "tool_schema");
		expect(firstSchemaTool, JSON.stringify(faux.contexts[0]?.tools?.map((tool) => tool.name))).toBeDefined();

		const secondSecret = faux.contexts[1]?.tools?.find((tool) => tool.name === "secret_tool");
		expect(JSON.stringify(secondSecret?.parameters)).toContain(SECRET_ARGUMENT);

		const schemaResult = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "tool_schema",
		);
		expect(JSON.stringify(schemaResult)).toContain(SECRET_ARGUMENT);

		session.dispose();
	});

	it("rejects unknown and inactive schema names without marking them loaded", async () => {
		const { loadToolSchema } = await import("../../src/core/tools/tool-schema.ts");
		const loaded: string[] = [];
		expect(() => loadToolSchema({ getTool: () => undefined, markLoaded: (name) => loaded.push(name) }, "not_active")).toThrow(
			/inactive or unknown.*not_active/i,
		);
		expect(loaded).toEqual([]);
	});
});
