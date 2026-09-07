import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { AgentDefinition } from "../src/core/delegation/runtime.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { FilePermissionRuleStore } from "../src/core/permissions/store.ts";
import {
	SANDBOX_ENFORCEMENT_MARKER_VALUE,
	SANDBOX_ENFORCEMENT_MARKER_VARIABLE,
} from "../src/core/sandbox/cli-launch.ts";
import {
	createAgentSession,
	SDK_SANDBOX_ENFORCEMENT_MARKER_VALUE,
	SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE,
} from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let scratch: string;
let previousMarker: string | undefined;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "apex-sdk-sandbox-"));
	previousMarker = process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE];
	delete process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE];
});

afterEach(() => {
	if (previousMarker === undefined) delete process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE];
	else process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE] = previousMarker;
	rmSync(scratch, { recursive: true, force: true });
});

async function buildModelRuntime(providerId: string) {
	const faux = fauxProvider({ provider: providerId });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: [providerId] });
	return { faux, runtime };
}

async function session(providerId: string, sandbox?: "required" | "external" | "none") {
	const { faux, runtime } = await buildModelRuntime(providerId);
	return createAgentSession({
		cwd: scratch,
		agentDir: join(scratch, "agent"),
		model: faux.getModel(),
		modelRuntime: runtime,
		settingsManager: SettingsManager.create(scratch, join(scratch, "agent")),
		tools: ["read"],
		...(sandbox ? { sandbox } : {}),
	});
}

describe("SDK sandbox contract", () => {
	it("keeps the supervisor's marker name and value as the SDK's single source", () => {
		// One marker, named in the supervisor launch and read by the SDK. Two independent
		// spellings would be a drift the SDK could never detect at runtime.
		expect(SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE).toBe("APEX_CODE_SANDBOX_ENFORCED");
		expect(SDK_SANDBOX_ENFORCEMENT_MARKER_VALUE).toBe("1");
		expect(SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE).toBe(SANDBOX_ENFORCEMENT_MARKER_VARIABLE);
		expect(SDK_SANDBOX_ENFORCEMENT_MARKER_VALUE).toBe(SANDBOX_ENFORCEMENT_MARKER_VALUE);
	});

	it('refuses to construct a "required" session with no supervisor marker present', async () => {
		await expect(session("sdk-sandbox-required-absent", "required")).rejects.toThrow(/OS containment/i);
	});

	it('refuses to construct a "required" session when the marker holds any other value', async () => {
		process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE] = "true";
		await expect(session("sdk-sandbox-required-wrong", "required")).rejects.toThrow(/OS containment/i);
	});

	it('constructs a "required" session inside a supervisor child and reports no diagnostic', async () => {
		process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE] = SDK_SANDBOX_ENFORCEMENT_MARKER_VALUE;
		const result = await session("sdk-sandbox-required-present", "required");
		expect(result.sandboxContract).toBe("required");
		expect(result.sandboxDiagnostic).toBeUndefined();
		result.session.dispose();
	});

	it('constructs an "external" session and says the SDK cannot verify the containment', async () => {
		const result = await session("sdk-sandbox-external", "external");
		expect(result.sandboxContract).toBe("external");
		expect(result.sandboxDiagnostic).toMatch(/external/i);
		expect(result.sandboxDiagnostic).toMatch(/cannot verify/i);
		result.session.dispose();
	});

	it('defaults to "none" and says there is no OS containment', async () => {
		const result = await session("sdk-sandbox-default");
		expect(result.sandboxContract).toBe("none");
		expect(result.sandboxDiagnostic).toMatch(/no OS containment/i);
		result.session.dispose();
	});

	it('reports "none" even when the marker is present, because the caller did not ask for it', async () => {
		process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE] = SDK_SANDBOX_ENFORCEMENT_MARKER_VALUE;
		const result = await session("sdk-sandbox-none-with-marker", "none");
		expect(result.sandboxContract).toBe("none");
		expect(result.sandboxDiagnostic).toMatch(/no OS containment/i);
		result.session.dispose();
	});
});

const AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
	scout: { name: "scout", description: "Fast recon", tools: ["read"], systemPrompt: "You are a scout." },
};

async function delegatingSession(providerId: string, sandbox?: "required" | "external" | "none") {
	const { faux, runtime } = await buildModelRuntime(providerId);
	const store = new FilePermissionRuleStore({
		cwd: scratch,
		agentDir: join(scratch, "agent"),
		policyPath: join(scratch, "missing-policy.json"),
	});
	await store.apply({ type: "addRules", destination: "local", rules: [{ toolName: "delegate", behavior: "allow" }] });
	const { session: parent } = await createAgentSession({
		cwd: scratch,
		agentDir: join(scratch, "agent"),
		model: faux.getModel(),
		modelRuntime: runtime,
		settingsManager: SettingsManager.create(scratch, join(scratch, "agent")),
		tools: ["read", "delegate"],
		permissionGate: { store, getMode: () => "default" },
		delegation: { resolveAgent: (agentType) => AGENT_DEFINITIONS[agentType] },
		...(sandbox ? { sandbox } : {}),
	});
	await parent.bindExtensions({});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("delegate", { agentType: "scout", task: "look" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("scout looked", { stopReason: "stop" }),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	]);
	return parent;
}

function delegateResultText(parent: Awaited<ReturnType<typeof delegatingSession>>): string {
	return JSON.stringify(parent.agent.state.messages.filter((message) => message.role === "toolResult"));
}

describe("SDK sandbox contract inheritance", () => {
	it("makes a delegated child refuse when the parent required containment that has since gone", async () => {
		process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE] = SDK_SANDBOX_ENFORCEMENT_MARKER_VALUE;
		const parent = await delegatingSession("sdk-sandbox-delegate-required", "required");
		delete process.env[SDK_SANDBOX_ENFORCEMENT_MARKER_VARIABLE];

		await parent.prompt("delegate to scout");

		expect(delegateResultText(parent)).toMatch(/OS containment/i);
		parent.dispose();
	});

	it("lets a delegated child run when the parent asserted no containment (positive control)", async () => {
		const parent = await delegatingSession("sdk-sandbox-delegate-none");

		await parent.prompt("delegate to scout");

		expect(delegateResultText(parent)).not.toMatch(/OS containment/i);
		expect(delegateResultText(parent)).toMatch(/scout looked/);
		parent.dispose();
	});
});
