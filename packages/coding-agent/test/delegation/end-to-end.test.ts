import { mkdtemp, rm } from "node:fs/promises";
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
