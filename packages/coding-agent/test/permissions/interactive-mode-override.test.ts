import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { resolveEffectiveMode } from "../../src/core/permissions/startup.ts";
import {
	FilePermissionRuleStore,
	type PermissionMode,
	type WritablePermissionSource,
} from "../../src/core/permissions/store.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { rmScratchResilient, scratchDir } from "../suite/scratch.ts";
import { createTestResourceLoader } from "../utilities.ts";

let cwd: string;
let previousCwd: string;
const sessions: AgentSession[] = [];

beforeEach(async () => {
	cwd = await scratchDir("apex-interactive-mode-");
	previousCwd = process.cwd();
	process.chdir(cwd);
});

afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	process.chdir(previousCwd);
	await rmScratchResilient(cwd);
});

async function setup(
	options: {
		flagMode?: PermissionMode;
		source?: WritablePermissionSource;
		savedMode?: PermissionMode;
		getMode?: () => PermissionMode | Promise<PermissionMode>;
		sessionManager?: SessionManager;
		permissionGate?: false;
	} = {},
) {
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	const store = new FilePermissionRuleStore({
		cwd,
		agentDir,
		policyPath: join(cwd, "absent-policy.json"),
		projectTrusted: true,
	});
	if (options.source)
		await store.apply({ type: "setMode", destination: options.source, mode: options.savedMode ?? "plan" });
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const faux = fauxProvider({ provider: `interactive-mode-${Math.random().toString(36).slice(2)}` });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: [faux.getModel().provider] });
	const gate = {
		store,
		flagMode: options.flagMode,
		getMode:
			options.getMode ??
			(async () => resolveEffectiveMode(options.flagMode, (await store.snapshot()).modesBySource)),
	};
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: faux.getModel(),
		modelRuntime: runtime,
		settingsManager,
		sessionManager: options.sessionManager ?? SessionManager.create(cwd, join(cwd, "sessions")),
		resourceLoader: createTestResourceLoader(),
		tools: ["write", "delegate"],
		permissionGate: options.permissionGate === false ? undefined : gate,
		delegation: {
			resolveAgent: () => ({ name: "writer", description: "Writer", tools: ["write"], systemPrompt: "Write" }),
		},
	});
	sessions.push(session);
	return { session, store, settingsManager, gate, faux };
}

async function writeDecision(session: AgentSession, path = "marker.txt") {
	const args = { path, content: "written" };
	const toolCall = fauxToolCall("write", args);
	return session.agent.beforeToolCall!({
		toolCall,
		args,
		assistantMessage: fauxAssistantMessage([toolCall]),
		context: session.agent.state,
	});
}

describe("interactive session permission mode", () => {
	it.each(["flag", "local", "project", "user"] as const)(
		"overrides %s without changing persisted state",
		async (source) => {
			const { session, store, settingsManager, gate } = await setup(
				source === "flag" ? { flagMode: "plan" } : { source },
			);
			const snapshot = await store.snapshot();
			const settings = structuredClone(settingsManager.getGlobalSettings());
			const entries = structuredClone(session.sessionManager.getEntries());
			const messages = structuredClone(session.messages);
			const files = [
				join(cwd, "agent", "permissions.json"),
				join(cwd, ".apex-code", "permissions.json"),
				join(cwd, ".apex-code", "permissions.local.json"),
			];
			const contents = files.map((file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined));
			const getter = gate.getMode;
			expect((await writeDecision(session))?.block).toBe(true);
			expect(await session.setInteractivePermissionMode("acceptEdits")).toEqual({
				mode: "acceptEdits",
				origin: "interactive",
			});
			expect(session.getInteractivePermissionMode()).toBe("acceptEdits");
			expect(await session.getPermissionMode()).toEqual({ mode: "acceptEdits", origin: "interactive" });
			expect(await writeDecision(session)).toBeUndefined();
			expect(await store.snapshot()).toEqual(snapshot);
			expect(settingsManager.getGlobalSettings()).toEqual(settings);
			expect(session.sessionManager.getEntries()).toEqual(entries);
			expect(session.messages).toEqual(messages);
			expect(files.map((file) => (existsSync(file) ? readFileSync(file, "utf8") : undefined))).toEqual(contents);
			expect(gate.getMode).toBe(getter);
			session.clearInteractivePermissionMode();
			expect(session.getInteractivePermissionMode()).toBeUndefined();
			expect(await session.getPermissionMode()).toEqual({ mode: "plan", origin: source });
			expect((await writeDecision(session))?.block).toBe(true);
		},
	);

	it.each(["default", "acceptEdits"] as const)("retains explicit deny rules in %s", async (mode) => {
		const { session, store } = await setup();
		await store.apply({ type: "addRules", destination: "local", rules: [{ toolName: "write", behavior: "deny" }] });
		const before = await store.snapshot();
		await session.setInteractivePermissionMode(mode);
		expect((await writeDecision(session))?.block).toBe(true);
		expect(await store.snapshot()).toEqual(before);
	});

	it.each(["flag", "user"] as const)("allows bypass only when startup %s allowed it", async (source) => {
		const { session } = await setup(
			source === "flag" ? { flagMode: "bypassPermissions" } : { source, savedMode: "bypassPermissions" },
		);
		expect(await session.getInteractivePermissionModeCycle()).toEqual([
			"default",
			"acceptEdits",
			"plan",
			"bypassPermissions",
		]);
		await session.setInteractivePermissionMode("default");
		await expect(session.setInteractivePermissionMode("bypassPermissions")).resolves.toEqual({
			mode: "bypassPermissions",
			origin: "interactive",
		});
	});

	it("does not unlock bypass through a later saved settings write", async () => {
		const { session } = await setup({ flagMode: "default" });
		await session.setPermissionMode("bypassPermissions");
		expect(await session.getInteractivePermissionModeCycle()).toEqual(["default", "acceptEdits", "plan"]);
		await expect(session.setInteractivePermissionMode("bypassPermissions")).rejects.toThrow(/startup|started/i);
		expect(session.getInteractivePermissionMode()).toBeUndefined();
	});

	it("keeps the captured startup ceiling after clearing and reload", async () => {
		const { session } = await setup({ source: "user", savedMode: "default" });
		await session.setPermissionMode("bypassPermissions");
		await session.setInteractivePermissionMode("plan");
		await session.reload();
		expect(session.getInteractivePermissionMode()).toBeUndefined();
		expect(await session.getPermissionMode()).toEqual({ mode: "bypassPermissions", origin: "user" });
		await expect(session.setInteractivePermissionMode("bypassPermissions")).rejects.toThrow(/startup|started/i);
	});

	it("preserves a custom SDK getter when the override is cleared", async () => {
		const { session } = await setup({ getMode: () => "acceptEdits" });
		expect(await writeDecision(session)).toBeUndefined();
		await session.setInteractivePermissionMode("plan");
		expect((await writeDecision(session))?.block).toBe(true);
		session.clearInteractivePermissionMode();
		expect(await writeDecision(session)).toBeUndefined();
	});

	it.each(["clear", "reload"] as const)("does not revive a pending override after %s", async (reset) => {
		let resolve!: (mode: PermissionMode) => void;
		const captured = new Promise<PermissionMode>((done) => {
			resolve = done;
		});
		const { session } = await setup({ getMode: () => captured });
		const pending = session.setInteractivePermissionMode("plan");
		if (reset === "clear") session.clearInteractivePermissionMode();
		else await session.reload();
		resolve("default");
		await pending;
		expect(session.getInteractivePermissionMode()).toBeUndefined();
	});

	it("the newest pending choice wins", async () => {
		let resolve!: (mode: PermissionMode) => void;
		const captured = new Promise<PermissionMode>((done) => {
			resolve = done;
		});
		const { session } = await setup({ getMode: () => captured });
		const first = session.setInteractivePermissionMode("plan");
		const second = session.setInteractivePermissionMode("acceptEdits");
		resolve("default");
		await Promise.all([first, second]);
		expect(session.getInteractivePermissionMode()).toBe("acceptEdits");
	});

	it.each(["throw", "reject"] as const)(
		"handles a startup getter %s without replacing failed startup authority",
		async (kind) => {
			const failure = new Error("startup unavailable");
			const getter = vi.fn((): PermissionMode | Promise<PermissionMode> => {
				if (kind === "throw") throw failure;
				return Promise.reject(failure);
			});
			const { session } = await setup({ getMode: getter });
			await new Promise((done) => setTimeout(done, 0));
			await expect(session.setInteractivePermissionMode("plan")).rejects.toThrow(failure);
			await expect(session.getInteractivePermissionModeCycle()).rejects.toThrow(failure);
			expect(session.getInteractivePermissionMode()).toBeUndefined();
			expect(getter).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps /settings writes shadowed by the session choice", async () => {
		const { session, store } = await setup();
		await session.setInteractivePermissionMode("plan");
		expect(await session.setPermissionMode("acceptEdits")).toEqual({ mode: "plan", origin: "interactive" });
		expect((await store.snapshot()).modesBySource.get("user")).toBe("acceptEdits");
		session.clearInteractivePermissionMode();
		expect(await session.getPermissionMode()).toEqual({ mode: "acceptEdits", origin: "user" });
	});

	it("enforces the override at configured verification commands", async () => {
		const { session, settingsManager } = await setup();
		writeFileSync(
			join(cwd, "agent", "settings.json"),
			JSON.stringify({
				policies: {
					schemaVersion: 1,
					verification: [
						{
							id: "verify",
							executable: process.execPath,
							argv: ["-e", 'require("node:fs").writeFileSync("verified.txt", "yes")'],
							permission: "allow",
						},
					],
				},
			}),
		);
		await settingsManager.reload();
		expect(await session.requestVerification()).toBe("verified");
		unlinkSync(join(cwd, "verified.txt"));
		await session.setInteractivePermissionMode("plan");
		expect(await session.requestVerification()).not.toBe("verified");
		expect(existsSync(join(cwd, "verified.txt"))).toBe(false);
		session.clearInteractivePermissionMode();
		expect(await session.requestVerification()).toBe("verified");
		expect(readFileSync(join(cwd, "verified.txt"), "utf8")).toBe("yes");
	});

	it("new and resumed aggregates do not inherit the session mode", async () => {
		const { session } = await setup({ flagMode: "plan" });
		session.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session.sessionManager.appendMessage(fauxAssistantMessage("hello"));
		await session.setInteractivePermissionMode("acceptEdits");
		const file = session.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		const { session: resumed } = await setup({ flagMode: "plan", sessionManager: SessionManager.open(file) });
		const { session: fresh } = await setup({ flagMode: "plan" });
		for (const next of [resumed, fresh]) {
			expect(next.getInteractivePermissionMode()).toBeUndefined();
			expect(await next.getPermissionMode()).toEqual({ mode: "plan", origin: "flag" });
			expect((await writeDecision(next))?.block).toBe(true);
		}
	});

	it("has no interactive mode path when no permission gate is configured", async () => {
		const { session } = await setup({ permissionGate: false });
		expect(await session.getInteractivePermissionModeCycle()).toEqual([]);
		expect(await session.setInteractivePermissionMode("plan")).toBeUndefined();
		expect(session.getInteractivePermissionMode()).toBeUndefined();
		expect(await session.getPermissionMode()).toBeUndefined();
	});

	it("an existing delegated child follows parent changes and retains custom authority after clear", async () => {
		const { session, faux } = await setup({ getMode: () => "acceptEdits" });
		const respond = (file: string) =>
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: file, content: "yes" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done", { stopReason: "stop" }),
			]);
		respond("first.txt");
		const { handleId } = await session.startChildRun("writer", "first");
		await session.waitChildRunResult(handleId);
		expect(existsSync(join(cwd, "first.txt"))).toBe(true);
		await session.setInteractivePermissionMode("plan");
		respond("blocked.txt");
		await session.sendChildInput(handleId, "second");
		expect(existsSync(join(cwd, "blocked.txt"))).toBe(false);
		session.clearInteractivePermissionMode();
		respond("last.txt");
		await session.sendChildInput(handleId, "third");
		expect(existsSync(join(cwd, "last.txt"))).toBe(true);
	});
});
