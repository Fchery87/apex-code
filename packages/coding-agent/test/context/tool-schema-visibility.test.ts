/**
 * Hardening pass on task 4.1: the schema loader's `getTool` resolver must be scoped
 * to the session's *active* tool set (`AgentSession.getActiveToolNames()`), never the
 * full registration registry, across every way the active set can be shaped. Each
 * case below pins one shape so a future change to `_refreshToolRegistry` /
 * `_buildRuntime` cannot silently widen what `tool_schema` can see again.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "apex-code-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionConfig } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createFauxStreamFn, fauxModel } from "../test-harness.ts";
import { createTestResourceLoader } from "../utilities.ts";

/** A plain (non-Apex) ToolDefinition with no `contract` -- what an MCP/extension tool looks like. */
function createForeignTool(): ToolDefinition {
	return {
		name: "foreign_tool",
		label: "Foreign tool",
		description: "A tool with no declared contract, as an MCP server would register.",
		parameters: Type.Object({ value: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

async function loadSchema(
	targetName: string,
	sessionOptions: Partial<AgentSessionConfig>,
): Promise<{ schemaResult: unknown; blocked: boolean }> {
	const tempDir = join(tmpdir(), `apex-schema-visibility-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	try {
		const { streamFn } = createFauxStreamFn([
			{ toolCalls: [{ name: "tool_schema", args: { name: targetName } }] },
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
			...sessionOptions,
		});

		await session.prompt(`load the schema for ${targetName}`);
		await session.agent.waitForIdle();

		const schemaResult = session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "tool_schema",
		);
		session.dispose();
		return { schemaResult, blocked: (schemaResult as { isError?: boolean } | undefined)?.isError === true };
	} finally {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("tool_schema visibility across active-tool-set shapes (task 4.1 hardening)", () => {
	it("default tools: rejects a registered-but-inactive default tool (grep)", async () => {
		const { blocked, schemaResult } = await loadSchema("grep", {
			initialActiveToolNames: ["read", "bash", "edit", "write", "tool_schema"],
		});
		expect(blocked, JSON.stringify(schemaResult)).toBe(true);
		expect(JSON.stringify(schemaResult)).toMatch(/inactive or unknown.*grep/i);
	});

	it("default tools: succeeds for an active default tool (read)", async () => {
		const { blocked, schemaResult } = await loadSchema("read", {
			initialActiveToolNames: ["read", "bash", "edit", "write", "tool_schema"],
		});
		expect(blocked, JSON.stringify(schemaResult)).toBe(false);
	});

	it("no-builtin-tools: an override registry with only tool_schema active rejects any built-in name", async () => {
		const { blocked, schemaResult } = await loadSchema("read", {
			baseToolsOverride: {},
			initialActiveToolNames: ["tool_schema"],
		});
		expect(blocked, JSON.stringify(schemaResult)).toBe(true);
		expect(JSON.stringify(schemaResult)).toMatch(/inactive or unknown.*read/i);
	});

	it("excluded tools: an excluded tool is invisible to the schema loader even though it would otherwise be a default", async () => {
		const { blocked, schemaResult } = await loadSchema("grep", {
			excludedToolNames: ["grep"],
			initialActiveToolNames: ["read", "bash", "edit", "write", "tool_schema"],
		});
		expect(blocked, JSON.stringify(schemaResult)).toBe(true);
		expect(JSON.stringify(schemaResult)).toMatch(/inactive or unknown.*grep/i);
	});

	it("extension/foreign tools: an active foreign tool with no contract still resolves its real schema", async () => {
		const { blocked, schemaResult } = await loadSchema("foreign_tool", {
			customTools: [createForeignTool()],
			initialActiveToolNames: ["foreign_tool", "tool_schema"],
		});
		expect(blocked, JSON.stringify(schemaResult)).toBe(false);
		expect(JSON.stringify(schemaResult)).toContain("value");
	});

	it("empty active-tool set: with only tool_schema active, every other name is rejected as inactive", async () => {
		const { blocked, schemaResult } = await loadSchema("read", {
			initialActiveToolNames: ["tool_schema"],
		});
		expect(blocked, JSON.stringify(schemaResult)).toBe(true);
		expect(JSON.stringify(schemaResult)).toMatch(/inactive or unknown.*read/i);
	});
});
