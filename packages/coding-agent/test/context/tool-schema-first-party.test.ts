/**
 * Task 4.7: the 4.1 end-to-end proof used a test fixture ("secret_tool") to prove
 * the load path's mechanics. This proves the same path against a real first-party
 * tool that this phase actually deferred (`grep`, task 4.7's grep/find/ls decision):
 * announced without its schema, loaded on demand via `tool_schema`, then called with
 * valid arguments and a real result.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "apex-code-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createFauxStreamFn, fauxModel } from "../test-harness.ts";
import { createTestResourceLoader } from "../utilities.ts";

describe("deferred schema load path against a real first-party tool (task 4.7)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `apex-schema-load-first-party-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "haystack.txt"), "the needle is here\nother lines\n");
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("announces grep without its schema, loads the real schema on demand, then executes a valid grep call", async () => {
		const { streamFn, state: faux } = createFauxStreamFn([
			{ toolCalls: [{ name: "tool_schema", args: { name: "grep" } }] },
			{ toolCalls: [{ name: "grep", args: { pattern: "needle" } }] },
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

		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRuntime: getModelRuntime(registry),
			resourceLoader: createTestResourceLoader(),
			initialActiveToolNames: ["grep", "tool_schema"],
		});

		await session.prompt("find the needle");
		await session.agent.waitForIdle();

		expect(faux.callCount).toBe(3);

		// First request: grep is announced by name only, no "pattern" property visible.
		const firstGrep = faux.contexts[0]?.tools?.find((tool) => tool.name === "grep");
		expect(JSON.stringify(firstGrep?.parameters)).not.toContain("pattern");

		// Second request: after loading, grep's real schema (with "pattern") is projected.
		const secondGrep = faux.contexts[1]?.tools?.find((tool) => tool.name === "grep");
		expect(JSON.stringify(secondGrep?.parameters)).toContain("pattern");

		// The schema tool's own result carried the real schema.
		const schemaResult = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "tool_schema",
		);
		expect(JSON.stringify(schemaResult)).toContain("pattern");

		// And the real grep call actually ran and found the match.
		const grepResult = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "grep",
		);
		expect(JSON.stringify(grepResult)).toContain("needle");

		session.dispose();
	});
});
