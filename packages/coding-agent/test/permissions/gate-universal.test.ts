import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Agent, type BeforeToolCallContext, type BeforeToolCallResult } from "apex-code-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createPermissionGate, evaluateToolCall } from "../../src/core/permissions/gate.ts";
import type { PermissionResponder } from "../../src/core/permissions/responder.ts";
import { FilePermissionRuleStore } from "../../src/core/permissions/store.ts";
import { type ToolContract, UNCLASSIFIED } from "../../src/core/tools/contract.ts";
import { allToolNames, createAllToolDefinitions, createAllTools, type ToolName } from "../../src/core/tools/index.ts";

/** Schema-valid representative params per tool, so a call reaches the gate rather than failing argument validation first. */
const REPRESENTATIVE_PARAMS: Record<ToolName, unknown> = {
	read: { path: "file.txt" },
	write: { path: "file.txt", content: "hello" },
	edit: { path: "file.txt", edits: [{ oldText: "a", newText: "b" }] },
	grep: { pattern: "TODO" },
	find: { pattern: "*.ts" },
	ls: {},
	bash: { command: "echo test" },
	tool_schema: { name: "read" },
	todo_write: { todos: [{ content: "write the spec", status: "pending" }] },
	web_search: { query: "typescript generics" },
	// Port 1 refuses instantly and locally -- no external network dependency in tests.
	web_fetch: { url: "http://127.0.0.1:1/" },
	ask_user: { question: "Which approach?", options: ["a", "b"] },
	plan_present: { plan: "1. Do a thing" },
	delegate: { agentType: "explore", task: "find the config loader" },
	test: { executable: "npm", args: ["test", "--", "unit"] },
};

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "apex-permission-gate-"));
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

async function driveOneToolCallTurn(
	toolName: ToolName,
	params: unknown,
	beforeToolCall: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>,
): Promise<{ blocked: boolean; reason: string | undefined; toolExecuted: boolean }> {
	const providerId = `gate-test-${toolName}`;
	const faux = fauxProvider({ provider: providerId });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: [providerId] });

	await writeFile(join(scratch, "file.txt"), "a\n", "utf-8");

	let toolExecuted = false;
	const tools = Object.values(createAllTools(scratch)).map((tool) => ({
		...tool,
		execute: async (...executeArgs: Parameters<typeof tool.execute>) => {
			toolExecuted = true;
			return tool.execute(...executeArgs);
		},
	}));

	const toolCall = fauxToolCall(toolName, params as Record<string, unknown>);
	faux.setResponses([
		fauxAssistantMessage([toolCall], { stopReason: "toolUse" }),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	]);

	const agent = new Agent({
		initialState: { model: faux.getModel(), systemPrompt: "test", tools },
		streamFn: (model, context, options) => runtime.streamSimple(model, context, { ...options }),
		getApiKey: () => "offline-test",
		beforeToolCall,
	});

	await agent.prompt({ role: "user", content: "go", timestamp: Date.now() });

	const toolResultMessage = agent.state.messages.find((m) => m.role === "toolResult" && m.toolCallId === toolCall.id);
	if (toolResultMessage?.role !== "toolResult") throw new Error("Expected a tool result message");
	const text = toolResultMessage.content.find((c) => c.type === "text")?.text;
	// "Blocked" means the gate prevented execution — toolExecuted is the authoritative
	// signal. isError alone would also be true for a tool that ran and failed for an
	// unrelated reason (e.g. a missing binary), which is not what this test measures.
	return { blocked: !toolExecuted, reason: text, toolExecuted };
}

describe("permission gate — universal (invariant 2: every registered tool passes the gate)", () => {
	it.each([...allToolNames])("blocks %s when a blanket deny rule applies, and never executes it", async (toolName) => {
		const store = new FilePermissionRuleStore({
			cwd: scratch,
			agentDir: join(scratch, "agent"),
			policyPath: join(scratch, "missing-policy.json"),
		});
		await store.apply({ type: "addRules", destination: "local", rules: [{ toolName, behavior: "deny" }] });

		const definitions = createAllToolDefinitions(scratch);
		const beforeToolCall = createPermissionGate({
			getContract: (name) => definitions[name as ToolName]?.contract,
			store,
			getMode: () => "default",
		});

		const result = await driveOneToolCallTurn(toolName, REPRESENTATIVE_PARAMS[toolName], beforeToolCall);

		expect(result.blocked, `${toolName} should have been blocked`).toBe(true);
		expect(result.toolExecuted, `${toolName} must never execute once blocked`).toBe(false);
		expect(result.reason).toBeTruthy();
	});

	it.each([...allToolNames])("allows %s to execute when an explicit allow rule applies", async (toolName) => {
		const store = new FilePermissionRuleStore({
			cwd: scratch,
			agentDir: join(scratch, "agent"),
			policyPath: join(scratch, "missing-policy.json"),
		});
		await store.apply({ type: "addRules", destination: "local", rules: [{ toolName, behavior: "allow" }] });

		const definitions = createAllToolDefinitions(scratch);
		const beforeToolCall = createPermissionGate({
			getContract: (name) => definitions[name as ToolName]?.contract,
			store,
			getMode: () => "default",
		});

		const result = await driveOneToolCallTurn(toolName, REPRESENTATIVE_PARAMS[toolName], beforeToolCall);
		expect(result.blocked, `${toolName} should not have been blocked`).toBe(false);
		expect(result.toolExecuted, `${toolName} should have executed`).toBe(true);
	});
});

describe("permission gate — plan mode (task 4.3: state stays callable, mutation stays denied)", () => {
	it("executes todo_write under plan mode even with no explicit rule, through the real registry contract", async () => {
		const store = new FilePermissionRuleStore({
			cwd: scratch,
			agentDir: join(scratch, "agent"),
			policyPath: join(scratch, "missing-policy.json"),
		});
		const definitions = createAllToolDefinitions(scratch);
		const beforeToolCall = createPermissionGate({
			getContract: (name) => definitions[name as ToolName]?.contract,
			store,
			getMode: () => "plan",
		});

		const result = await driveOneToolCallTurn("todo_write", REPRESENTATIVE_PARAMS.todo_write, beforeToolCall);
		expect(result.blocked, JSON.stringify(result)).toBe(false);
		expect(result.toolExecuted).toBe(true);
	});

	it.each(["write", "bash", "delegate"] as const)(
		"still denies %s under plan mode's hard floor, through the real registry contract",
		async (toolName) => {
			const store = new FilePermissionRuleStore({
				cwd: scratch,
				agentDir: join(scratch, "agent"),
				policyPath: join(scratch, "missing-policy.json"),
			});
			const definitions = createAllToolDefinitions(scratch);
			const beforeToolCall = createPermissionGate({
				getContract: (name) => definitions[name as ToolName]?.contract,
				store,
				getMode: () => "plan",
			});

			const result = await driveOneToolCallTurn(toolName, REPRESENTATIVE_PARAMS[toolName], beforeToolCall);
			expect(result.blocked, JSON.stringify(result)).toBe(true);
			expect(result.toolExecuted).toBe(false);
		},
	);

	it.each(["web_search", "web_fetch"] as const)(
		"task 4.4: %s (net capability) is not denied by plan mode's hard floor -- an explicit allow rule still executes",
		async (toolName) => {
			const store = new FilePermissionRuleStore({
				cwd: scratch,
				agentDir: join(scratch, "agent"),
				policyPath: join(scratch, "missing-policy.json"),
			});
			await store.apply({ type: "addRules", destination: "local", rules: [{ toolName, behavior: "allow" }] });

			const definitions = createAllToolDefinitions(scratch);
			const beforeToolCall = createPermissionGate({
				getContract: (name) => definitions[name as ToolName]?.contract,
				store,
				getMode: () => "plan",
			});

			const result = await driveOneToolCallTurn(toolName, REPRESENTATIVE_PARAMS[toolName], beforeToolCall);
			expect(result.blocked, JSON.stringify(result)).toBe(false);
			expect(result.toolExecuted).toBe(true);
		},
	);

	it.each(["ask_user", "plan_present"] as const)(
		"task 4.5: %s (ui capability) is not denied by plan mode's hard floor, even with no explicit rule (allow default)",
		async (toolName) => {
			const store = new FilePermissionRuleStore({
				cwd: scratch,
				agentDir: join(scratch, "agent"),
				policyPath: join(scratch, "missing-policy.json"),
			});
			const definitions = createAllToolDefinitions(scratch);
			const beforeToolCall = createPermissionGate({
				getContract: (name) => definitions[name as ToolName]?.contract,
				store,
				getMode: () => "plan",
			});

			const result = await driveOneToolCallTurn(toolName, REPRESENTATIVE_PARAMS[toolName], beforeToolCall);
			expect(result.blocked, JSON.stringify(result)).toBe(false);
			expect(result.toolExecuted).toBe(true);
		},
	);
});

describe("permission gate — decision plumbing (evaluateToolCall)", () => {
	function inMemoryStore(): FilePermissionRuleStore {
		return new FilePermissionRuleStore({
			cwd: "/nonexistent",
			agentDir: "/nonexistent/agent",
			policyPath: "/nonexistent/policy.json",
			backends: {
				local: memoryBackend(),
				project: memoryBackend(),
				user: memoryBackend(),
			},
		});
	}

	function memoryBackend() {
		let value: string | undefined;
		return {
			withLock: <T>(fn: (current: string | undefined) => { result: T; next?: string }) => {
				const { result, next } = fn(value);
				if (next !== undefined) value = next;
				return result;
			},
			withLockAsync: async <T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>) => {
				const { result, next } = await fn(value);
				if (next !== undefined) value = next;
				return result;
			},
		};
	}

	it("an ask resolution awaits the responder and honors an allow answer", async () => {
		const store = inMemoryStore();
		const responder: PermissionResponder = { ask: async () => ({ allow: true }) };
		const contract: ToolContract = {
			...UNCLASSIFIED,
			permission: { ...UNCLASSIFIED.permission, defaultBehavior: "ask" },
		};
		const result = await evaluateToolCall(
			"custom-tool",
			{ x: 1 },
			{ getContract: () => contract, store, getMode: () => "default", responder },
		);
		expect(result.block).toBe(false);
	});

	it("an ask resolution with no responder denies (fails closed)", async () => {
		const store = inMemoryStore();
		const contract: ToolContract = {
			...UNCLASSIFIED,
			permission: { ...UNCLASSIFIED.permission, defaultBehavior: "ask" },
		};
		const result = await evaluateToolCall(
			"custom-tool",
			{ x: 1 },
			{ getContract: () => contract, store, getMode: () => "default" },
		);
		expect(result.block).toBe(true);
	});

	it("a responder answering 'always allow' persists a session-source rule via the tool's own ruleForCall", async () => {
		const store = inMemoryStore();
		const responder: PermissionResponder = { ask: async () => ({ allow: true, persist: true }) };
		const contract: ToolContract = {
			capabilities: new Set(["fs.read"]),
			permission: {
				defaultBehavior: "ask",
				matches: (ruleContent, params: any) => ruleContent === params.path,
				describe: (ruleContent) => `read ${ruleContent}`,
				ruleForCall: (params: any) => params.path,
			},
			context: { resultRecoverable: true, deferSchema: false },
			evidence: { emits: new Set(), capture: () => [] },
		};

		const first = await evaluateToolCall(
			"read",
			{ path: "a.txt" },
			{ getContract: () => contract, store, getMode: () => "default", responder },
		);
		expect(first.block).toBe(false);

		// The persisted session rule now authorizes the same call without asking again.
		const second = await evaluateToolCall(
			"read",
			{ path: "a.txt" },
			{ getContract: () => contract, store, getMode: () => "default" },
		);
		expect(second.block).toBe(false);
	});

	it("fails closed when an authorization source cannot be loaded", async () => {
		const contract: ToolContract = {
			...UNCLASSIFIED,
			permission: { ...UNCLASSIFIED.permission, defaultBehavior: "allow" },
		};
		const store = {
			snapshot: async () => ({
				rules: [],
				modesBySource: new Map(),
				errors: [{ source: "policy" as const, error: new Error("unreadable") }],
			}),
			apply: async () => {},
		};
		const result = await evaluateToolCall(
			"custom-tool",
			{},
			{ getContract: () => contract, store, getMode: () => "default" },
		);
		expect(result).toMatchObject({ block: true });
		expect(result.reason).toContain("policy");
	});

	it("a foreign tool with no contract receives UNCLASSIFIED rather than being rejected or silently allowed", async () => {
		const store = inMemoryStore();
		const result = await evaluateToolCall(
			"mcp-mystery-tool",
			{ anything: true },
			{ getContract: () => undefined, store, getMode: () => "default" },
		);
		// UNCLASSIFIED defaults to ask; with no responder, ask fails closed.
		expect(result.block).toBe(true);
	});
});
