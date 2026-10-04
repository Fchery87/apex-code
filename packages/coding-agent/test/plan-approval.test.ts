import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { resolveEffectiveMode } from "../src/core/permissions/startup.ts";
import { FilePermissionRuleStore, type PermissionMode } from "../src/core/permissions/store.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { rmScratchResilient, scratchDir } from "./suite/scratch.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

let cwd: string;
let previousCwd: string;
const sessions: AgentSession[] = [];
beforeEach(async () => {
	cwd = await scratchDir("apex-plan-approval-");
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
		mode?: PermissionMode;
		tools?: string[];
		excludeTools?: string[];
		noTools?: "all" | "builtin";
		defaults?: string[];
		getMode?: () => PermissionMode | Promise<PermissionMode>;
		noGate?: boolean;
		extensions?: ExtensionFactory[];
		sessionManager?: SessionManager;
		savedMode?: PermissionMode;
	} = {},
) {
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	const store = new FilePermissionRuleStore({
		cwd,
		agentDir,
		projectTrusted: true,
		policyPath: join(cwd, "absent-policy.json"),
	});
	if (options.savedMode) await store.apply({ type: "setMode", destination: "user", mode: options.savedMode });
	const recorded: Array<{ toolName: string; records: unknown[] }> = [];
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	if (options.defaults) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: options.defaults }));
		await settingsManager.reload();
	}
	const faux = fauxProvider({ provider: `plan-${Math.random().toString(36).slice(2)}` });
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
		settingsManager,
		sessionManager: options.sessionManager ?? SessionManager.create(cwd, join(cwd, "sessions")),
		evidenceSink: { record: (entry) => recorded.push(entry) },
		resourceLoader: createTestResourceLoader({
			extensionsResult: await createTestExtensionsResult(options.extensions ?? [], cwd),
		}),
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		permissionGate: options.noGate
			? undefined
			: {
					store,
					flagMode: options.mode,
					getMode:
						options.getMode ??
						(async () => resolveEffectiveMode(options.mode, (await store.snapshot()).modesBySource)),
				},
	});
	sessions.push(session);
	if (
		options.mode === "plan" &&
		!options.tools?.length &&
		!options.excludeTools?.includes("plan_present") &&
		options.noTools !== "all"
	)
		await vi.waitFor(() => expect(session.getActiveToolNames()).toContain("plan_present"));
	return { session, store, settingsManager, faux, recorded };
}
function ui(select: ExtensionUIContext["select"]) {
	return { select, notify: vi.fn() } as unknown as ExtensionUIContext;
}
async function present(session: AgentSession, choice: string | undefined, signal?: AbortSignal) {
	const context = ui(async () => choice);
	await session.bindExtensions({ uiContext: context });
	return session.agent.state.tools
		.find((t) => t.name === "plan_present")!
		.execute("plan-id", { plan: "Read then edit" }, signal);
}
describe("session plan approval", () => {
	it("adds the implicit tool in plan mode and removes it after approval without persistence", async () => {
		const { session, store, settingsManager } = await setup({ mode: "plan" });
		const before = await store.snapshot();
		const settings = structuredClone(settingsManager.getGlobalSettings());
		expect(session.getActiveToolNames()).toContain("plan_present");
		const result = await present(session, "Yes, and accept edits");
		expect(result.details).toEqual({ plan: "Read then edit", approved: true, nextMode: "acceptEdits" });
		expect(await session.getPermissionMode()).toEqual({ mode: "acceptEdits", origin: "interactive" });
		expect(session.getActiveToolNames()).not.toContain("plan_present");
		expect(await store.snapshot()).toEqual(before);
		expect(settingsManager.getGlobalSettings()).toEqual(settings);
	});
	it.each(["Yes, and ask before each edit", "No, keep planning", undefined])("handles %s", async (choice) => {
		const { session } = await setup({ mode: "plan" });
		const result = await present(session, choice);
		expect(result.details).toEqual(
			choice?.startsWith("Yes")
				? { plan: "Read then edit", approved: true, nextMode: "default" }
				: { plan: "Read then edit", approved: false },
		);
		expect(session.getActiveToolNames().includes("plan_present")).toBe(!choice?.startsWith("Yes"));
	});
	it.each([{ tools: ["read", "plan_present"] }, { defaults: ["read", "plan_present"] }])(
		"retains explicit intent %j",
		async (options) => {
			const { session } = await setup({ ...options, mode: "plan" });
			await present(session, "Yes, and accept edits");
			expect(session.getActiveToolNames()).toContain("plan_present");
		},
	);
	it.each([{ tools: ["read"] }, { excludeTools: ["plan_present"] }, { noTools: "all" as const }])(
		"respects registry ceiling %j",
		async (options) => {
			const { session } = await setup({ ...options, mode: "plan" });
			expect(session.getActiveToolNames()).not.toContain("plan_present");
		},
	);
	it("SDK builtin noTools keeps mode tool available", async () => {
		const { session } = await setup({ mode: "plan", noTools: "builtin" });
		expect(session.getActiveToolNames()).toContain("plan_present");
		expect(session.getActiveToolNames()).not.toContain("read");
	});
	it("public setters retain explicit inclusion and project excluded inclusion", async () => {
		const { session } = await setup({ mode: "plan" });
		session.setActiveToolsByName(["read"]);
		expect(session.getActiveToolNames()).toEqual(["read", "plan_present"]);
		await session.setInteractivePermissionMode("default");
		expect(session.getActiveToolNames()).toEqual(["read"]);
		await session.setInteractivePermissionMode("plan");
		session.setActiveToolsByName(["read", "plan_present"]);
		await session.setInteractivePermissionMode("default");
		expect(session.getActiveToolNames()).toEqual(["read", "plan_present"]);
	});
	it("reload does not promote an implicit selection", async () => {
		const { session } = await setup();
		await session.setInteractivePermissionMode("plan");
		expect(session.getActiveToolNames()).toContain("plan_present");
		await session.reload();
		expect(session.getActiveToolNames()).not.toContain("plan_present");
	});
	it("cannot approve a session without a gate", async () => {
		const { session } = await setup({ tools: ["plan_present"], noGate: true });
		await expect(present(session, "Yes, and accept edits")).rejects.toThrow(/permission gate|cannot apply/i);
	});
	it.each(["abort", "reload", "dispose", "rebind", "mode"] as const)(
		"rejects obsolete dialog after %s",
		async (change) => {
			const { session } = await setup({ mode: "plan" });
			let release!: (value: string) => void;
			await session.bindExtensions({
				uiContext: ui(
					() =>
						new Promise((resolve) => {
							release = resolve;
						}),
				),
			});
			const tool = session.agent.state.tools.find((t) => t.name === "plan_present")!;
			const pending = tool.execute("id", { plan: "Old plan" });
			await vi.waitFor(() => expect(release).toBeTypeOf("function"));
			if (change === "abort") await session.abort();
			if (change === "reload") await session.reload();
			if (change === "dispose") session.dispose();
			if (change === "rebind") await session.bindExtensions({ uiContext: ui(async () => undefined) });
			if (change === "mode") await session.setInteractivePermissionMode("default");
			release("Yes, and accept edits");
			await expect(pending).rejects.toThrow(/obsolete|cancel|abort/i);
			expect(session.getInteractivePermissionMode()).not.toBe("acceptEdits");
		},
	);
	it("repaints the real interactive footer after registered plan approval", async () => {
		initTheme("dark");
		const { session } = await setup({ mode: "plan" });
		const selector = vi.fn(async () => "Yes, and accept edits");
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session },
			isInitialized: true,
			pendingTools: new Map(),
			footer: { invalidate: vi.fn(), setPermissionMode: vi.fn() },
			ui: { requestRender: vi.fn() },
			showExtensionSelector: selector,
			showStatus: vi.fn(),
		});
		const uiContext = Reflect.get(InteractiveMode.prototype, "createExtensionUIContext").call(mode);
		await session.bindExtensions({ uiContext });
		const tool = session.agent.state.tools.find((t) => t.name === "plan_present")!;
		const result = await tool.execute("id", { plan: "Read then edit" });
		expect(selector).toHaveBeenCalledWith(
			"Approve this plan?",
			["Yes, and accept edits", "Yes, and ask before each edit", "No, keep planning"],
			{ signal: undefined },
		);
		await Reflect.get(InteractiveMode.prototype, "handleEvent").call(mode, {
			type: "tool_execution_end",
			toolName: "plan_present",
			toolCallId: "id",
			result,
			isError: false,
		});
		expect(mode.footer.setPermissionMode).toHaveBeenCalledWith("acceptEdits", "interactive");
	});
	it("changes the next real provider request after approval", async () => {
		const { session, faux } = await setup({ mode: "plan" });
		await session.bindExtensions({ uiContext: ui(async () => "Yes, and accept edits") });
		const requests: TranscriptContext[] = [];
		const names: string[][] = [];
		const oldPrepare = session.agent.prepareNextTurnWithContext!;
		session.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const result = await oldPrepare(turn, signal);
			names.push((result?.context?.tools ?? []).map((t) => t.name));
			return result;
		};
		faux.setResponses([
			(request) => {
				requests.push(request);
				return fauxAssistantMessage(fauxToolCall("plan_present", { plan: "Read then edit" }), {
					stopReason: "toolUse",
				});
			},
			(request) => {
				requests.push(request);
				return fauxAssistantMessage("Proceeding");
			},
		]);
		await session.prompt("Plan a change");
		expect(requests).toHaveLength(2);
		expect(requests[0]!.messages[0]?.role).toBe("system");
		expect(JSON.stringify(requests[0])).toContain("plan_present");
		expect(names[0]).not.toContain("plan_present");
		const update = requests[1]!.messages.filter((m) => m.role === "system").at(-1);
		expect(update?.toolsRemoved).toContainEqual({ name: "plan_present" });
		expect(await session.getPermissionMode()).toEqual({ mode: "acceptEdits", origin: "interactive" });
	});
	it("observes a live custom getter on first and later requests", async () => {
		let mode: PermissionMode = "default";
		const { session, faux } = await setup({ getMode: () => mode });
		const tools: string[][] = [];
		faux.setResponses([
			() => {
				tools.push(session.getActiveToolNames());
				return fauxAssistantMessage("one");
			},
			() => {
				tools.push(session.getActiveToolNames());
				return fauxAssistantMessage("two");
			},
		]);
		mode = "plan";
		await session.prompt("one");
		mode = "default";
		await session.prompt("two");
		expect(tools[0]).toContain("plan_present");
		expect(tools[1]).not.toContain("plan_present");
	});
	it("keeps hook-edited tools scoped to a run", async () => {
		let first = true;
		const { session, faux } = await setup({
			extensions: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (first) {
							event.systemPromptOptions.selectedTools = ["read"];
							first = false;
						}
					});
				},
			],
		});
		const tools: string[][] = [];
		faux.setResponses([
			() => {
				tools.push(session.getActiveToolNames());
				return fauxAssistantMessage("one");
			},
			() => {
				tools.push(session.getActiveToolNames());
				return fauxAssistantMessage("two");
			},
		]);
		await session.prompt("one");
		await session.prompt("two");
		expect(tools[0]).toEqual(["read"]);
		expect(tools[1]).toContain("write");
	});
	it.each(["abort", "rebind", "dispose"] as const)("does not commit a pending setter after %s", async (change) => {
		let release!: (mode: PermissionMode) => void;
		const startup = new Promise<PermissionMode>((resolve) => {
			release = resolve;
		});
		const { session } = await setup({ tools: ["plan_present"], getMode: () => startup });
		await session.bindExtensions({ uiContext: ui(async () => "Yes, and accept edits") });
		const pending = session.agent.state.tools
			.find((t) => t.name === "plan_present")!
			.execute("id", { plan: "Pending" });
		await Promise.resolve();
		await Promise.resolve();
		if (change === "abort") await session.abort();
		if (change === "rebind") await session.bindExtensions({ uiContext: ui(async () => undefined) });
		if (change === "dispose") session.dispose();
		release("plan");
		await expect(pending).rejects.toThrow(/obsolete|cancel|abort/i);
		expect(session.getInteractivePermissionMode()).toBeUndefined();
	});
	it("does not promote an implicit tool copied through a hook edit", async () => {
		const { session, faux } = await setup({
			mode: "plan",
			extensions: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(
							(name) => name !== "bash",
						);
					});
				},
			],
		});
		await session.bindExtensions({ uiContext: ui(async () => "Yes, and accept edits") });
		const requests: TranscriptContext[] = [];
		let continuationTools: string[] = [];
		faux.setResponses([
			(request) => {
				requests.push(request);
				return fauxAssistantMessage(fauxToolCall("plan_present", { plan: "Plan" }), { stopReason: "toolUse" });
			},
			(request) => {
				requests.push(request);
				continuationTools = session.getActiveToolNames();
				return fauxAssistantMessage("done");
			},
		]);
		await session.prompt("Plan a change");
		expect(continuationTools).not.toContain("plan_present");
		expect(continuationTools).not.toContain("bash");
		const update = requests[1]!.messages.filter((m) => m.role === "system").at(-1);
		expect(update?.toolsRemoved).toContainEqual({ name: "plan_present" });
	});

	it("projects the restored historical tools into session prompt immediately", async () => {
		const { session, faux } = await setup();
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		session.setActiveToolsByName(["read"]);
		await session.prompt("first");
		const target = session.sessionManager.getLeafId()!;
		await session.setInteractivePermissionMode("plan");
		await session.prompt("second");
		await session.navigateTree(target);
		expect(session.getActiveToolNames()).toContain("plan_present");
		expect(session.systemPrompt).toContain("plan_present");
	});

	it("does not pin a recorded implicit plan tool through tree navigation", async () => {
		const { session, faux } = await setup({ mode: "plan" });
		faux.setResponses([fauxAssistantMessage("Planned"), fauxAssistantMessage("Later")]);
		await session.prompt("first");
		const target = session.sessionManager.getLeafId()!;
		await present(session, "Yes, and accept edits");
		await session.prompt("later");
		await session.navigateTree(target);
		expect(session.getActiveToolNames()).not.toContain("plan_present");
		expect(session.getInteractivePermissionMode()).toBe("acceptEdits");
	});
	it("preserves known explicit plan intent through tree navigation", async () => {
		const { session, faux } = await setup({ defaults: ["read"] });
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("later")]);
		await session.prompt("first");
		const target = session.sessionManager.getLeafId()!;
		session.setActiveToolsByName(["read", "plan_present"]);
		await session.prompt("later");
		await session.navigateTree(target);
		expect(session.getActiveToolNames()).toContain("plan_present");
	});

	it.each(["Yes, and accept edits", "Yes, and ask before each edit"])(
		"updates actual edit authorization with %s",
		async (choice) => {
			const { session } = await setup({ mode: "plan" });
			const toolCall = fauxToolCall("write", { path: "marker.txt", content: "written" });
			const context = {
				toolCall,
				args: toolCall.arguments,
				assistantMessage: fauxAssistantMessage([toolCall]),
				context: session.agent.state,
			};
			expect((await session.agent.beforeToolCall!(context))?.block).toBe(true);
			await present(session, choice);
			const decision = await session.agent.beforeToolCall!(context);
			if (choice === "Yes, and accept edits") expect(decision).toBeUndefined();
			else expect(decision?.block).toBe(true);
		},
	);
	it("captures approval mode through the real evidence sink", async () => {
		const { session, faux, recorded } = await setup({ mode: "plan" });
		await session.bindExtensions({ uiContext: ui(async () => "Yes, and ask before each edit") });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("plan_present", { plan: "Evidence plan" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await session.prompt("Plan");
		expect(recorded).toContainEqual({
			toolName: "plan_present",
			records: [{ kind: "workflow", plan: "Evidence plan", approved: true, nextMode: "default" }],
		});
	});
	it("resumes without turning recorded automatic tools into explicit intent", async () => {
		const { session, faux } = await setup({ mode: "plan" });
		faux.setResponses([fauxAssistantMessage("Planned")]);
		await session.prompt("Plan");
		const file = session.sessionFile!;
		session.dispose();
		const resumed = await setup({ sessionManager: SessionManager.open(file) });
		expect(resumed.session.getInteractivePermissionMode()).toBeUndefined();
		expect(resumed.session.getActiveToolNames()).not.toContain("plan_present");
	});
	it("activates from a saved plan mode when its captured getter settles", async () => {
		const { session } = await setup({ savedMode: "plan" });
		await vi.waitFor(() => expect(session.getActiveToolNames()).toContain("plan_present"));
	});
	it("uses custom mode authority instead of a conflicting saved plan", async () => {
		const { session, faux } = await setup({ savedMode: "plan", getMode: () => "default" });
		faux.setResponses([fauxAssistantMessage("default")]);
		await session.prompt("Default");
		expect(session.getActiveToolNames()).not.toContain("plan_present");
	});
	it("does not repaint a replacement session after an obsolete tool footer read", async () => {
		const { session } = await setup();
		let release!: (value: { mode: "acceptEdits"; origin: "interactive" }) => void;
		vi.spyOn(session, "getPermissionMode").mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session },
			isInitialized: true,
			pendingTools: new Map(),
			footer: { invalidate: vi.fn(), setPermissionMode: vi.fn() },
			ui: { requestRender: vi.fn() },
		});
		const pending = Reflect.get(InteractiveMode.prototype, "handleEvent").call(mode, {
			type: "tool_execution_end",
			toolName: "plan_present",
			toolCallId: "id",
			result: { content: [], details: {} },
			isError: false,
		});
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		mode.runtimeHost.session = (await setup()).session;
		release({ mode: "acceptEdits", origin: "interactive" });
		await pending;
		expect(mode.footer.setPermissionMode).not.toHaveBeenCalled();
	});
	it("does not refresh permission chrome for a failed plan tool", async () => {
		const { session } = await setup();
		const read = vi.spyOn(session, "getPermissionMode");
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session },
			isInitialized: true,
			pendingTools: new Map(),
			footer: { invalidate: vi.fn(), setPermissionMode: vi.fn() },
			ui: { requestRender: vi.fn() },
		});
		await Reflect.get(InteractiveMode.prototype, "handleEvent").call(mode, {
			type: "tool_execution_end",
			toolName: "plan_present",
			toolCallId: "id",
			result: { content: [], details: {} },
			isError: true,
		});
		expect(read).not.toHaveBeenCalled();
	});
	it("waits for the latest pending mode read before sending a request", async () => {
		let reads = 0;
		let first!: (mode: PermissionMode) => void;
		let latest!: (mode: PermissionMode) => void;
		const firstRead = new Promise<PermissionMode>((resolve) => {
			first = resolve;
		});
		const latestRead = new Promise<PermissionMode>((resolve) => {
			latest = resolve;
		});
		const { session, faux } = await setup({
			mode: "plan",
			getMode: () => {
				reads++;
				return reads === 1 ? "plan" : reads === 2 ? firstRead : latestRead;
			},
		});
		const names: string[][] = [];
		faux.setResponses([
			() => {
				names.push(session.getActiveToolNames());
				return fauxAssistantMessage("done");
			},
		]);
		const pending = session.prompt("Plan");
		await vi.waitFor(() => expect(reads).toBe(2));
		session.clearInteractivePermissionMode();
		await vi.waitFor(() => expect(reads).toBe(3));
		first("plan");
		let sentBeforeLatest = 0;
		await vi
			.waitFor(() => expect(faux.state.callCount).toBeGreaterThan(0), { timeout: 1000, interval: 10 })
			.then(
				() => {
					sentBeforeLatest = faux.state.callCount;
				},
				() => {},
			);
		latest("plan");
		await pending;
		expect(sentBeforeLatest).toBe(0);
		expect(names[0]).toContain("plan_present");
	});

	it("reports the latest getter failure even if its background read already settled", async () => {
		let reads = 0;
		let first!: (mode: PermissionMode) => void;
		let fail!: (error: Error) => void;
		const firstRead = new Promise<PermissionMode>((resolve) => {
			first = resolve;
		});
		const latestRead = new Promise<PermissionMode>((_resolve, reject) => {
			fail = reject;
		});
		const { session, faux } = await setup({
			mode: "plan",
			getMode: () => {
				reads++;
				return reads === 1 ? "plan" : reads === 2 ? firstRead : latestRead;
			},
		});
		faux.setResponses([fauxAssistantMessage("unexpected")]);
		const pending = session.prompt("Plan").then(
			() => undefined,
			(error) => error,
		);
		await vi.waitFor(() => expect(reads).toBe(2));
		session.clearInteractivePermissionMode();
		await vi.waitFor(() => expect(reads).toBe(3));
		fail(new Error("Latest mode read failed"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		first("plan");
		const error = await pending;
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("Latest mode read failed");
		expect(faux.state.callCount).toBe(0);
	});

	it.each(["before", "after"] as const)(
		"uses a known override %s following an obsolete background getter",
		async (order) => {
			let reads = 0;
			let first!: (mode: PermissionMode) => void;
			let latest!: (mode: PermissionMode) => void;
			const firstRead = new Promise<PermissionMode>((resolve) => {
				first = resolve;
			});
			const latestRead = new Promise<PermissionMode>((resolve) => {
				latest = resolve;
			});
			const { session, faux } = await setup({
				mode: "plan",
				getMode: () => {
					reads++;
					return reads === 1 ? "plan" : reads === 2 ? firstRead : latestRead;
				},
			});
			const names: string[][] = [];
			faux.setResponses([
				() => {
					names.push(session.getActiveToolNames());
					return fauxAssistantMessage("done");
				},
			]);
			const pending = session.prompt("Plan");
			await vi.waitFor(() => expect(reads).toBe(2));
			session.clearInteractivePermissionMode();
			await vi.waitFor(() => expect(reads).toBe(3));
			if (order === "after") {
				first("plan");
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(faux.state.callCount).toBe(0);
			}
			await session.setInteractivePermissionMode("acceptEdits");
			if (order === "before") first("plan");
			let advanced = false;
			await vi
				.waitFor(() => expect(faux.state.callCount).toBe(1), { timeout: 1000, interval: 10 })
				.then(
					() => {
						advanced = true;
					},
					() => {},
				);
			latest("plan");
			await pending;
			expect(advanced).toBe(true);
			expect(names[0]).not.toContain("plan_present");
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(session.getInteractivePermissionMode()).toBe("acceptEdits");
			expect(session.getActiveToolNames()).not.toContain("plan_present");
		},
	);
});
