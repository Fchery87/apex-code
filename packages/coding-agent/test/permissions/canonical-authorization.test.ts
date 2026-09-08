import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Agent } from "apex-code-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createMcpToolDefinition } from "../../src/core/mcp/mcp-tool.ts";
import { McpMetadataCache } from "../../src/core/mcp/metadata-cache.ts";
import { McpServerManager } from "../../src/core/mcp/server-manager.ts";
import type { McpServerConfig } from "../../src/core/mcp/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createPermissionGate, evaluateToolCall } from "../../src/core/permissions/gate.ts";
import type { PermissionResponder } from "../../src/core/permissions/responder.ts";
import { type PermissionRule, resolvePermission } from "../../src/core/permissions/rules.ts";
import { createBashPermissionSpec, createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { type ToolContract, UNCLASSIFIED } from "../../src/core/tools/contract.ts";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import type { ToolsOptions } from "../../src/core/tools/index.ts";
import { createPathPermissionSpec } from "../../src/core/tools/path-permission.ts";
import { createReadToolDefinition } from "../../src/core/tools/read.ts";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";
import { scratchDir } from "../suite/scratch.ts";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("validated canonical operation values", () => {
	it("runs prepareCall before resolving authorization on the same execution input", async () => {
		const input = { path: "target.txt" };
		let prepared = false;
		const store = {
			snapshot: async () => ({ rules: [], modesBySource: new Map(), errors: [] }),
			apply: async () => {},
		};
		const contract = {
			...UNCLASSIFIED,
			permission: {
				...UNCLASSIFIED.permission,
				defaultBehavior: "allow" as const,
				prepareCall(value: { path: string }) {
					prepared = true;
					value.path = "canonical-target";
				},
			},
		};
		const decision = await evaluateToolCall("read", input, {
			getContract: () => contract,
			store,
			getMode: () => "default",
		});
		expect(decision.block).toBe(false);
		expect(prepared).toBe(true);
		expect(input.path).toBe("canonical-target");
	});
});

describe("canonical path authorization", () => {
	it("uses @ and symlink aliases as the executed target", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		await writeFile(join(cwd, "secret.txt"), "private");
		await symlink("secret.txt", join(cwd, "alias.txt"));
		const spec = createPathPermissionSpec({
			cwd,
			defaultBehavior: "allow",
			verb: "Read",
			getPath: (p: { path: string }) => p.path,
		} as never);
		expect(spec.matches("secret.txt", { path: "@alias.txt" } as never)).toBe(true);
		expect(spec.matches("secret.txt", { path: "@secret.txt" } as never)).toBe(true);
	});
	it("does not treat literal glob characters in an exact approval as patterns", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		const spec = createPathPermissionSpec({
			cwd,
			defaultBehavior: "allow",
			verb: "Read",
			getPath: (p: { path: string }) => p.path,
		} as never);
		const rule = spec.ruleForCall({ path: "*.txt" } as never);
		expect(rule).not.toBe("*.txt");
		expect(spec.matches(rule!, { path: "*.txt" } as never)).toBe(true);
		expect(spec.matches(rule!, { path: "other.txt" } as never)).toBe(false);
	});
	it("the public agent loop refuses a replaced authorized read target", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		const allowed = join(cwd, "allowed.txt");
		const moved = join(cwd, "moved.txt");
		const denied = join(cwd, "denied.txt");
		await writeFile(allowed, "allowed");
		await writeFile(denied, "denied");

		const providerId = "canonical-read-race";
		const faux = fauxProvider({ provider: providerId });
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: [providerId] });

		const definition = createReadToolDefinition(cwd);
		const store = {
			snapshot: async () => ({ rules: [], modesBySource: new Map(), errors: [] }),
			apply: async () => {},
		};
		const permissionGate = createPermissionGate({
			getContract: () => definition.contract,
			store,
			getMode: () => "default",
		});
		let replaced = false;
		const beforeToolCall = async (...args: Parameters<typeof permissionGate>) => {
			const result = await permissionGate(...args);
			if (!result?.block) {
				await rename(allowed, moved);
				await symlink("denied.txt", allowed);
				replaced = true;
			}
			return result;
		};
		const call = fauxToolCall("read", { path: "allowed.txt" });
		faux.setResponses([
			fauxAssistantMessage([call], { stopReason: "toolUse" }),
			fauxAssistantMessage("done", { stopReason: "stop" }),
		]);
		const agent = new Agent({
			initialState: { model: faux.getModel(), systemPrompt: "test", tools: [wrapToolDefinition(definition)] },
			streamFn: (model, context, options) => runtime.streamSimple(model, context, { ...options }),
			getApiKey: () => "offline-test",
			beforeToolCall,
		});

		await agent.prompt({ role: "user", content: "read it", timestamp: Date.now() });

		expect(replaced).toBe(true);
		const result = agent.state.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === call.id,
		);
		expect(result?.role).toBe("toolResult");
		if (result?.role !== "toolResult") throw new Error("Expected tool result");
		expect(result.isError).toBe(true);
		expect(result.content).not.toContainEqual({ type: "text", text: "denied" });
	});
});

describe("bash authorization structure", () => {
	const bash = createBashPermissionSpec();
	it("does not let a blanket allow erase a scoped deny in a mixed command", () => {
		const rules: PermissionRule[] = [
			{ source: "policy", behavior: "deny", toolName: "bash", ruleContent: "touch:*" },
			{ source: "session", behavior: "allow", toolName: "bash" },
		];
		expect(resolvePermission(rules, "bash", bash, { command: "echo ok; touch denied" } as never).behavior).not.toBe(
			"allow",
		);
	});
	it("preserves exact quoted whitespace in approvals", () => {
		const rule = bash.ruleForCall({ command: 'printf "a  b\n"' } as never);
		expect(rule).not.toBe('printf "a b\n"');
		expect(bash.matches(rule!, { command: 'printf "a  b\n"' } as never)).toBe(true);
		expect(bash.matches(rule!, { command: 'printf "a b\n"' } as never)).toBe(false);
	});
});

function inertStore(): {
	snapshot: () => Promise<{ rules: PermissionRule[]; modesBySource: Map<never, never>; errors: [] }>;
	apply: () => Promise<void>;
} {
	return {
		snapshot: async () => ({ rules: [], modesBySource: new Map<never, never>(), errors: [] }),
		apply: async () => {},
	};
}

function persistingStore(): {
	rules: PermissionRule[];
	snapshot: () => Promise<{ rules: PermissionRule[]; modesBySource: Map<never, never>; errors: [] }>;
	apply: (update: { type: string; rules?: readonly PermissionRule[] }) => Promise<void>;
} {
	const rules: PermissionRule[] = [];
	return {
		rules,
		snapshot: async () => ({ rules: [...rules], modesBySource: new Map<never, never>(), errors: [] }),
		apply: async (update) => {
			if (update.type === "addRules" && update.rules) rules.push(...update.rules);
		},
	};
}

const allowOnce: PermissionResponder = { ask: async () => ({ allow: true }) };

async function expectGateAllowed(
	definition: { contract: ToolContract },
	toolName: string,
	input: unknown,
): Promise<void> {
	const decision = await evaluateToolCall(toolName, input, {
		getContract: () => definition.contract,
		store: inertStore() as never,
		getMode: () => "default",
		responder: allowOnce,
	});
	expect(decision.block).toBe(false);
}

describe("gated write execution against a replaced target", () => {
	it("refuses a write whose authorized existing target is swapped for a symlink", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		const allowed = join(cwd, "allowed.txt");
		await writeFile(allowed, "allowed");
		await writeFile(join(cwd, "denied.txt"), "denied");
		const input = { path: "allowed.txt", content: "attacker" };
		const definition = createWriteToolDefinition(cwd);
		await expectGateAllowed(definition, "write", input);

		await rename(allowed, join(cwd, "moved.txt"));
		await symlink("denied.txt", allowed);

		await expect(definition.execute("call", input, undefined, undefined, {} as never)).rejects.toThrow(
			/changed before execution/,
		);
		expect(await readFile(join(cwd, "denied.txt"), "utf-8")).toBe("denied");
		expect(await readFile(join(cwd, "moved.txt"), "utf-8")).toBe("allowed");
	});

	it("refuses a write whose authorized existing target is swapped for a different regular file", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		const allowed = join(cwd, "allowed.txt");
		await writeFile(allowed, "allowed");
		const input = { path: "allowed.txt", content: "attacker" };
		const definition = createWriteToolDefinition(cwd);
		await expectGateAllowed(definition, "write", input);

		// Same name, same readable content pattern, different inode: only the
		// descriptor identity check can reject this replacement.
		await rename(allowed, join(cwd, "moved.txt"));
		await writeFile(allowed, "impostor");

		await expect(definition.execute("call", input, undefined, undefined, {} as never)).rejects.toThrow(
			/changed before execution/,
		);
		expect(await readFile(join(cwd, "moved.txt"), "utf-8")).toBe("allowed");
		expect(await readFile(allowed, "utf-8")).toBe("impostor");
	});

	it("refuses a new-file write whose missing parent is replaced by a symlink before execution", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		await mkdir(join(cwd, "fresh"));
		await writeFile(join(cwd, "secret.txt"), "secret");
		const input = { path: "fresh/nested/file.txt", content: "attacker" };
		const definition = createWriteToolDefinition(cwd);
		await expectGateAllowed(definition, "write", input);

		await symlink(join(cwd, "secret.txt"), join(cwd, "fresh", "nested"));

		await expect(definition.execute("call", input, undefined, undefined, {} as never)).rejects.toThrow(
			/changed before execution/,
		);
		expect(await readFile(join(cwd, "secret.txt"), "utf-8")).toBe("secret");
	});

	it("refuses a new-file write when the target name is pre-placed as a symlink", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		await writeFile(join(cwd, "secret.txt"), "secret");
		const input = { path: "brand-new.txt", content: "attacker" };
		const definition = createWriteToolDefinition(cwd);
		await expectGateAllowed(definition, "write", input);

		await symlink("secret.txt", join(cwd, "brand-new.txt"));

		await expect(definition.execute("call", input, undefined, undefined, {} as never)).rejects.toThrow(
			/changed before execution/,
		);
		expect(await readFile(join(cwd, "secret.txt"), "utf-8")).toBe("secret");
	});

	it("still writes an authorized new file and overwrites an authorized existing file when nothing is swapped", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		await mkdir(join(cwd, "fresh"));
		await writeFile(join(cwd, "existing.txt"), "old");
		const definition = createWriteToolDefinition(cwd);

		const newInput = { path: "fresh/nested/file.txt", content: "new" };
		await expectGateAllowed(definition, "write", newInput);
		await definition.execute("call", newInput, undefined, undefined, {} as never);
		expect(await readFile(join(cwd, "fresh", "nested", "file.txt"), "utf-8")).toBe("new");

		const existingInput = { path: "existing.txt", content: "rewritten" };
		await expectGateAllowed(definition, "write", existingInput);
		await definition.execute("call", existingInput, undefined, undefined, {} as never);
		expect(await readFile(join(cwd, "existing.txt"), "utf-8")).toBe("rewritten");
	});
});

describe("gated edit execution against a replaced target", () => {
	it("refuses an edit whose authorized target is swapped before execution", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		const target = join(cwd, "edit.txt");
		await writeFile(target, "hello");
		await writeFile(join(cwd, "denied.txt"), "hello");
		const input = { path: "edit.txt", edits: [{ oldText: "hello", newText: "goodbye" }] };
		const definition = createEditToolDefinition(cwd);
		await expectGateAllowed(definition, "edit", input);

		// Same-name impostor with identical text: only the descriptor identity
		// check can reject this replacement.
		await rename(target, join(cwd, "moved.txt"));
		await writeFile(target, "hello");
		await expect(definition.execute("call", input, undefined, undefined, {} as never)).rejects.toThrow(
			/changed before execution/,
		);
		expect(await readFile(join(cwd, "moved.txt"), "utf-8")).toBe("hello");

		// Symlink alias onto the unauthorized file.
		await rename(target, join(cwd, "impostor.txt"));
		await symlink("denied.txt", target);
		await expect(definition.execute("call", input, undefined, undefined, {} as never)).rejects.toThrow(
			/changed before execution/,
		);
		expect(await readFile(join(cwd, "denied.txt"), "utf-8")).toBe("hello");
		expect(await readFile(join(cwd, "moved.txt"), "utf-8")).toBe("hello");
	});

	it("still edits an authorized target when nothing is swapped", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		await writeFile(join(cwd, "edit.txt"), "hello");
		const input = { path: "edit.txt", edits: [{ oldText: "hello", newText: "goodbye" }] };
		const definition = createEditToolDefinition(cwd);
		await expectGateAllowed(definition, "edit", input);
		await definition.execute("call", input, undefined, undefined, {} as never);
		expect(await readFile(join(cwd, "edit.txt"), "utf-8")).toBe("goodbye");
	});
});

describe("exact bash approvals through the public gate", () => {
	const definition = createBashToolDefinition(process.cwd());
	function gateOptions(store: ReturnType<typeof persistingStore>, responder?: PermissionResponder) {
		return {
			getContract: () => definition.contract,
			store: store as never,
			getMode: () => "default" as const,
			responder,
		};
	}

	it("does not reuse a persisted exact approval when quoted structure, comments, or newlines change", async () => {
		const store = persistingStore();
		const approval = gateOptions(store, { ask: async () => ({ allow: true, persist: true }) });
		const first = await evaluateToolCall("bash", { command: 'printf "a  b\\n"' }, approval);
		expect(first.block).toBe(false);
		expect(store.rules).toHaveLength(1);
		expect(store.rules[0]?.behavior).toBe("allow");

		// The identical command resolves allow from the persisted rule alone.
		const same = await evaluateToolCall("bash", { command: 'printf "a  b\\n"' }, gateOptions(store));
		expect(same.block).toBe(false);

		// Different quoting inside the string is a different command; ask fails closed.
		const altered = await evaluateToolCall("bash", { command: 'printf "a b\\n"' }, gateOptions(store));
		expect(altered.block).toBe(true);

		// An appended comment is grammar the approval never covered.
		const comment = await evaluateToolCall("bash", { command: 'printf "a  b\\n" # touch evil' }, gateOptions(store));
		expect(comment.block).toBe(true);

		// An appended newline introduces a second command segment.
		const newline = await evaluateToolCall("bash", { command: 'printf "a  b\\n"\ntouch evil' }, gateOptions(store));
		expect(newline.block).toBe(true);
	});
});

describe("conditional mcp registry mediation through the public agent loop", () => {
	const serverConfig: McpServerConfig = {
		name: "synthetic",
		transport: { kind: "stdio", command: "defunct-mcp-server", args: [], env: {}, cwd: undefined },
		capabilities: new Set(["state" as const]),
		lifecycle: "lazy",
		idleTimeoutMinutes: 10,
	};

	function mcpOptions(scratch: string): ToolsOptions {
		const servers = new Map([[serverConfig.name, serverConfig]]);
		return {
			mcp: {
				servers,
				cache: new McpMetadataCache(join(scratch, "mcp-metadata.json")),
				manager: new McpServerManager({
					servers,
					connector: async () => {
						throw new Error("no MCP server may start in this test");
					},
				}),
			},
		};
	}

	async function driveMcpTurn(cwd: string, rules: PermissionRule[]) {
		const providerId = "canonical-mcp-registry";
		const faux = fauxProvider({ provider: providerId });
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: [providerId] });

		const store = {
			snapshot: async () => ({ rules, modesBySource: new Map<never, never>(), errors: [] }),
			apply: async () => {},
		};
		const definition = createMcpToolDefinition(mcpOptions(cwd).mcp!);
		const permissionGate = createPermissionGate({
			getContract: () => definition.contract,
			store,
			getMode: () => "default",
		});
		const call = fauxToolCall("mcp", { search: "synthetic" });
		faux.setResponses([
			fauxAssistantMessage([call], { stopReason: "toolUse" }),
			fauxAssistantMessage("done", { stopReason: "stop" }),
		]);
		const agent = new Agent({
			initialState: {
				model: faux.getModel(),
				systemPrompt: "test",
				tools: [wrapToolDefinition(definition)],
			},
			streamFn: (model, context, options) => runtime.streamSimple(model, context, { ...options }),
			getApiKey: () => "offline-test",
			beforeToolCall: permissionGate,
		});
		await agent.prompt({ role: "user", content: "search mcp tools", timestamp: Date.now() });
		const result = agent.state.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === call.id,
		);
		expect(result?.role).toBe("toolResult");
		if (result?.role !== "toolResult") throw new Error("Expected tool result");
		return result;
	}

	it("a scoped deny blocks the mcp tool before any execution", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		const result = await driveMcpTurn(cwd, [
			{ source: "policy", behavior: "deny", toolName: "mcp", ruleContent: "Mcp(metadata)" },
		]);
		expect(result.isError).toBe(true);
		expect(result.content).not.toContainEqual({ type: "text", text: expect.stringContaining("No cached MCP tool") });
	});

	it("a scoped allow runs a metadata search cache-only, contacting no server", async () => {
		const cwd = await scratchDir("apex-ca-");
		dirs.push(cwd);
		const result = await driveMcpTurn(cwd, [
			{ source: "session", behavior: "allow", toolName: "mcp", ruleContent: "Mcp(metadata)" },
		]);
		expect(result.isError).toBe(false);
		expect(result.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining('No cached MCP tool matches "synthetic"'),
				}),
			]),
		);
	});
});
