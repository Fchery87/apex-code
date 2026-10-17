import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resolveEffectiveMode } from "../src/core/permissions/startup.ts";
import { FilePermissionRuleStore, type PermissionMode } from "../src/core/permissions/store.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { rmScratchResilient, scratchDir } from "./suite/scratch.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

let cwd: string;
let previousCwd: string;
const sessions: AgentSession[] = [];
beforeEach(async () => {
	cwd = await scratchDir("apex-plan-tools-");
	previousCwd = process.cwd();
	process.chdir(cwd);
});
afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	process.chdir(previousCwd);
	await rmScratchResilient(cwd);
});

async function sessionIn(mode: PermissionMode): Promise<AgentSession> {
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	const store = new FilePermissionRuleStore({
		cwd,
		agentDir,
		projectTrusted: true,
		policyPath: join(cwd, "absent-policy.json"),
	});
	const faux = fauxProvider({ provider: `plan-tools-${Math.random().toString(36).slice(2)}` });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: [faux.getModel().provider] });
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		modelRuntime: runtime,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
		sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
		resourceLoader: createTestResourceLoader({
			extensionsResult: await createTestExtensionsResult([], cwd),
		}),
		permissionGate: {
			store,
			flagMode: mode,
			getMode: async () => resolveEffectiveMode(mode, (await store.snapshot()).modesBySource),
		},
	});
	sessions.push(session);
	if (mode === "plan") await vi.waitFor(() => expect(session.getActiveToolNames()).toContain("plan_present"));
	return session;
}

describe("plan mode active tools (HR.13)", () => {
	it("in plan mode the model keeps read-only search tools and loses the mutating ones", async () => {
		const session = await sessionIn("plan");
		const active = session.getActiveToolNames();
		expect(active).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "plan_present"]));
		expect(active).not.toContain("bash");
		expect(active).not.toContain("edit");
		expect(active).not.toContain("write");
		expect(active).not.toContain("delegate");
	});

	it("the prompt does not recommend bash for file operations once bash is not active", async () => {
		const session = await sessionIn("plan");
		expect(session.systemPrompt).not.toMatch(/Use bash for file operations/);
	});

	it("leaving plan mode restores the requested tool set", async () => {
		const session = await sessionIn("plan");
		await session.setInteractivePermissionMode("default");
		const active = session.getActiveToolNames();
		expect(active).toContain("bash");
		expect(active).toContain("edit");
	});
});
