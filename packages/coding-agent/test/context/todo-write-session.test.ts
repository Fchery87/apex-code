import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "apex-code-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { getLatestTodos } from "../../src/core/session-manager.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createFauxStreamFn, fauxModel } from "../test-harness.ts";
import { createTestResourceLoader } from "../utilities.ts";

describe("todo_write persists through the real session-facing store (task 4.3)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `apex-todo-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("records the submitted list on the real SessionManager, readable via getLatestTodos", async () => {
		const { streamFn } = createFauxStreamFn([
			{
				toolCalls: [{
					name: "todo_write",
					args: { todos: [{ content: "write the spec", status: "in_progress" }] },
				}],
			},
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

		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRuntime: getModelRuntime(registry),
			resourceLoader: createTestResourceLoader(),
			initialActiveToolNames: ["todo_write"],
		});

		await session.prompt("start the task");
		await session.agent.waitForIdle();

		expect(getLatestTodos(sessionManager.getEntries())).toEqual([{ content: "write the spec", status: "in_progress" }]);

		session.dispose();
	});

	it("a second call replaces the recorded list rather than merging with the first", async () => {
		const { streamFn } = createFauxStreamFn([
			{
				toolCalls: [{
					name: "todo_write",
					args: { todos: [{ content: "write the spec", status: "completed" }, { content: "implement it", status: "in_progress" }] },
				}],
			},
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

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry("todo", [{ content: "write the spec", status: "in_progress" }]);

		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRuntime: getModelRuntime(registry),
			resourceLoader: createTestResourceLoader(),
			initialActiveToolNames: ["todo_write"],
		});

		await session.prompt("continue the task");
		await session.agent.waitForIdle();

		expect(getLatestTodos(sessionManager.getEntries())).toEqual([
			{ content: "write the spec", status: "completed" },
			{ content: "implement it", status: "in_progress" },
		]);

		session.dispose();
	});
});
