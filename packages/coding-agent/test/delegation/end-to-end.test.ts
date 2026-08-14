import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { AgentDefinition } from "../../src/core/delegation/runtime.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { FilePermissionRuleStore } from "../../src/core/permissions/store.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "apex-delegation-e2e-"));
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

const AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
	scout: { name: "scout", description: "Fast recon", tools: ["read"], systemPrompt: "You are a scout." },
	worker: { name: "worker", description: "General purpose", tools: ["read", "bash"], systemPrompt: "You are a worker." },
};

async function buildModelRuntime(providerId: string) {
	const faux = fauxProvider({ provider: providerId });
	const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: [providerId] });
	return { faux, runtime };
}

async function buildParentSession(providerId: string) {
	const { faux, runtime } = await buildModelRuntime(providerId);
	const settingsManager = SettingsManager.create(scratch, join(scratch, "agent"));
	const store = new FilePermissionRuleStore({
		cwd: scratch,
		agentDir: join(scratch, "agent"),
		policyPath: join(scratch, "missing-policy.json"),
	});
	await store.apply({ type: "addRules", destination: "local", rules: [{ toolName: "delegate", behavior: "allow" }] });

	const { session } = await createAgentSession({
		cwd: scratch,
		agentDir: join(scratch, "agent"),
		model: faux.getModel(),
		modelRuntime: runtime,
		settingsManager,
		tools: ["read", "delegate"],
		permissionGate: { store, getMode: () => "default" },
		delegation: { resolveAgent: (agentType) => AGENT_DEFINITIONS[agentType] },
	});
	await session.bindExtensions({});
	return { session, faux };
}

describe("delegation end-to-end through createAgentSession (task 5.2)", () => {
	it("delegates to a real child session and returns the child's real output to the parent", async () => {
		const { session, faux } = await buildParentSession("delegation-e2e-1");
		const delegateCall = fauxToolCall("delegate", { agentType: "scout", task: "find the config loader" });
		faux.setResponses([
			fauxAssistantMessage([delegateCall], { stopReason: "toolUse" }),
			fauxAssistantMessage("scout found it in config.ts", { stopReason: "stop" }), // the child's own turn
			fauxAssistantMessage("Delegation complete.", { stopReason: "stop" }), // the parent's turn after the tool result
		]);

		await session.prompt("delegate to scout");

		const toolResult = session.agent.state.messages.find(
			(m) => m.role === "toolResult" && m.toolCallId === delegateCall.id,
		);
		if (toolResult?.role !== "toolResult") throw new Error("expected a tool result message");
		expect(toolResult.isError).toBe(false);
		const text = toolResult.content.find((c) => c.type === "text")?.text;
		expect(text).toContain("scout found it in config.ts");

		session.dispose();
	});

	it("stores a real child's session only under its per-child artifact directory while a permitted workspace write succeeds", async () => {
		const { faux, runtime } = await buildModelRuntime("delegation-artifacts-e2e");
		const agentDir = join(scratch, "agent");
		const settingsManager = SettingsManager.create(scratch, agentDir);
		const store = new FilePermissionRuleStore({ cwd: scratch, agentDir, policyPath: join(scratch, "missing-policy.json") });
		await store.apply({
			type: "addRules", destination: "local", rules: [
				{ toolName: "delegate", behavior: "allow" },
				{ toolName: "write", behavior: "allow", ruleContent: "child-output.txt" },
			],
		});
		const { session } = await createAgentSession({
			cwd: scratch, agentDir, model: faux.getModel(), modelRuntime: runtime, settingsManager,
			tools: ["read", "write", "delegate"], permissionGate: { store, getMode: () => "default" },
			delegation: { resolveAgent: (agentType) => agentType === "writer" ? {
				name: "writer", description: "writes workspace output", tools: ["write"], systemPrompt: "Write the requested file.",
			} : undefined },
		});
		await session.bindExtensions({});
		const delegateCall = fauxToolCall("delegate", { agentType: "writer", task: "write child-output.txt" });
		const writeCall = fauxToolCall("write", { path: "child-output.txt", content: "workspace edit" });
		faux.setResponses([
			fauxAssistantMessage([delegateCall], { stopReason: "toolUse" }),
			fauxAssistantMessage([writeCall], { stopReason: "toolUse" }),
			fauxAssistantMessage("child wrote the workspace file", { stopReason: "stop" }),
			fauxAssistantMessage("done", { stopReason: "stop" }),
		]);
		await session.prompt("delegate to writer");
		expect(await readFile(join(scratch, "child-output.txt"), "utf8")).toBe("workspace edit");
		const result = session.agent.state.messages.find((m) => m.role === "toolResult" && m.toolCallId === delegateCall.id);
		if (result?.role !== "toolResult") throw new Error("expected a delegation result");
		expect(result.isError).toBe(false);
		const childJsonl = await (async () => {
			const { readdir } = await import("node:fs/promises");
			const roots = await readdir(join(session.sessionManager.getSessionDir(), "delegations"));
			expect(roots).toHaveLength(1);
			return join(session.sessionManager.getSessionDir(), "delegations", roots[0]!, (await readdir(join(session.sessionManager.getSessionDir(), "delegations", roots[0]!))).find((f) => f.endsWith(".jsonl"))!);
		})();
		await access(childJsonl);
		expect(childJsonl).toContain(`${session.sessionManager.getSessionDir()}/delegations/`);
		session.dispose();
	});

	it("refuses delegation whose requested tools exceed the parent's capabilities -- never yields a child holding bash", async () => {
		const { session, faux } = await buildParentSession("delegation-e2e-2");
		const delegateCall = fauxToolCall("delegate", { agentType: "worker", task: "run the test suite" });
		faux.setResponses([
			fauxAssistantMessage([delegateCall], { stopReason: "toolUse" }),
			fauxAssistantMessage("Noted the refusal.", { stopReason: "stop" }),
		]);

		// The parent's active tools are only read + delegate -- no exec anywhere,
		// so "worker" (which needs bash => exec) must be refused before any child exists.
		await session.prompt("delegate to worker");

		const toolResult = session.agent.state.messages.find(
			(m) => m.role === "toolResult" && m.toolCallId === delegateCall.id,
		);
		if (toolResult?.role !== "toolResult") throw new Error("expected a tool result message");
		expect(toolResult.isError).toBe(true);
		const text = toolResult.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toMatch(/exec/i);

		session.dispose();
	});
});

describe("delegation recursion depth guard through createAgentSession (task 5.3)", () => {
	it("admits delegation up to the default bound (2) and refuses a third level, naming the bound", async () => {
		// A self-delegating agent, so depth actually gets exercised: root (depth 0)
		// -> child (depth 1) -> grandchild (depth 2), where the grandchild's own
		// attempt to delegate again is refused by the depth guard before any
		// great-grandchild session is built.
		const recursiveDefinitions: Record<string, AgentDefinition> = {
			scout: { name: "scout", description: "recon, can delegate further", tools: ["read", "delegate"], systemPrompt: "You are a scout." },
		};
		const { faux, runtime } = await buildModelRuntime("delegation-depth-e2e");
		const settingsManager = SettingsManager.create(scratch, join(scratch, "agent"));
		const store = new FilePermissionRuleStore({
			cwd: scratch,
			agentDir: join(scratch, "agent"),
			policyPath: join(scratch, "missing-policy.json"),
		});
		await store.apply({ type: "addRules", destination: "local", rules: [{ toolName: "delegate", behavior: "allow" }] });

		const { session } = await createAgentSession({
			cwd: scratch,
			agentDir: join(scratch, "agent"),
			model: faux.getModel(),
			modelRuntime: runtime,
			settingsManager,
			tools: ["read", "delegate"],
			permissionGate: { store, getMode: () => "default" },
			delegation: { resolveAgent: (agentType) => recursiveDefinitions[agentType] },
		});
		await session.bindExtensions({});

		const rootCall = fauxToolCall("delegate", { agentType: "scout", task: "T1" });
		const childCall = fauxToolCall("delegate", { agentType: "scout", task: "T2" });
		const grandchildCall = fauxToolCall("delegate", { agentType: "scout", task: "T3" });
		faux.setResponses([
			fauxAssistantMessage([rootCall], { stopReason: "toolUse" }), // root, depth 0: delegates
			fauxAssistantMessage([childCall], { stopReason: "toolUse" }), // child, depth 1: delegates
			fauxAssistantMessage([grandchildCall], { stopReason: "toolUse" }), // grandchild, depth 2: tries to delegate again -- refused
			fauxAssistantMessage("grandchild done", { stopReason: "stop" }), // grandchild's final turn, after the depth refusal
			fauxAssistantMessage("child done", { stopReason: "stop" }), // child's final turn
			fauxAssistantMessage("root done", { stopReason: "stop" }), // root's final turn
		]);

		await session.prompt("go");

		// The precise signal: exactly 6 model turns fired (root x2, child x2,
		// grandchild x2). If the depth guard failed to block the grandchild's
		// third-level delegate call, a real great-grandchild session would need at
		// least one more turn -- the faux provider's response queue is shift()-based,
		// not cycling, so an extra call would consume a response meant for a
		// different level and cascade into either an off-by-one output or an
		// exhausted-queue error. This assertion catches that directly rather than
		// inferring it from shifted text.
		expect(faux.state.callCount).toBe(6);

		const rootResult = session.agent.state.messages.find(
			(m) => m.role === "toolResult" && m.toolCallId === rootCall.id,
		);
		if (rootResult?.role !== "toolResult") throw new Error("expected root's tool result");
		expect(rootResult.isError).toBe(false);
		const rootText = rootResult.content.find((c) => c.type === "text")?.text ?? "";
		expect(rootText).toContain("child done");

		session.dispose();
	});
});
