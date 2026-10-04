import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { TaskPanelComponent } from "../src/modes/interactive/components/task-panel.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { rmScratchResilient, scratchDir } from "./suite/scratch.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

let cwd: string;
let oldCwd: string;
const sessions: AgentSession[] = [];
beforeEach(async () => {
	cwd = await scratchDir("apex-task-session-");
	oldCwd = process.cwd();
	process.chdir(cwd);
});
afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	process.chdir(oldCwd);
	await rmScratchResilient(cwd);
});
async function setup(options: { manager?: SessionManager; extensions?: ExtensionFactory[]; tools?: string[] } = {}) {
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const faux = fauxProvider({ provider: `tasks-${Math.random().toString(36).slice(2)}` });
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
		settingsManager: settings,
		sessionManager: options.manager ?? SessionManager.create(cwd, join(cwd, "sessions")),
		resourceLoader: createTestResourceLoader({
			extensionsResult: await createTestExtensionsResult(options.extensions ?? [], cwd),
		}),
		tools: options.tools ?? ["todo_write"],
	});
	sessions.push(session);
	return { session, settings, faux };
}
const tasks = [{ content: "Build", status: "in_progress" }];
describe("task panel session boundary", () => {
	it("uses real persisted tool snapshots and hides completion only at settlement without model chrome", async () => {
		const { session, settings, faux } = await setup();
		const panel = new TaskPanelComponent({ getSession: () => session, getSettings: () => settings });
		const during: string[][] = [];
		session.subscribe((event) => {
			panel.handleEvent(event);
			if (event.type === "tool_execution_end") during.push(panel.render(80));
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("todo_write", { todos: tasks }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Ready"),
		]);
		await session.prompt("Build");
		expect(panel.render(80)).toEqual(["Tasks 0/1 · Build"]);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("todo_write", { todos: [{ content: "Build", status: "completed" }] }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done"),
		]);
		await session.prompt("Complete");
		expect(during).toEqual([["Tasks 0/1 · Build"], ["Tasks 1/1"]]);
		expect(panel.render(80)).toEqual([]);
		expect(JSON.stringify(session.messages)).not.toContain("Tasks 1/1");
	});
	it("tracks real SDK tree navigation and resumed pre-compaction branch state", async () => {
		const { session, settings, faux } = await setup();
		faux.setResponses([fauxAssistantMessage("Start")]);
		await session.prompt("Start");
		const taskId = session.sessionManager.appendCustomEntry("todo", tasks);
		session.sessionManager.appendCustomEntry("todo", []);
		const panel = new TaskPanelComponent({ getSession: () => session, getSettings: () => settings });
		expect(panel.render(80)).toEqual([]);
		await session.navigateTree(taskId, { workspacePolicy: "keep" });
		expect(panel.render(80)).toEqual(["Tasks 0/1 · Build"]);
		session.sessionManager.appendCompaction("Earlier history", null, 100);
		expect(panel.render(80)).toEqual(["Tasks 0/1 · Build"]);
		const resumed = await setup({ manager: SessionManager.open(session.sessionManager.getSessionFile()!) });
		const resumedPanel = new TaskPanelComponent({
			getSession: () => resumed.session,
			getSettings: () => resumed.settings,
		});
		expect(resumedPanel.render(80)).toEqual(["Tasks 0/1 · Build"]);
	});
	it("reflects actual run hook loadout and restores visibility after cleanup", async () => {
		const { session, settings, faux } = await setup({
			tools: ["read", "todo_write"],
			extensions: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.selectedTools = ["read"];
					});
				},
			],
		});
		session.sessionManager.appendCustomEntry("todo", tasks);
		const panel = new TaskPanelComponent({ getSession: () => session, getSettings: () => settings });
		expect(panel.render(80)).toEqual(["Tasks 0/1 · Build"]);
		faux.setResponses([
			() => {
				expect(panel.render(80)).toEqual([]);
				return fauxAssistantMessage("Read");
			},
		]);
		await session.prompt("Read");
		expect(panel.render(80)).toEqual(["Tasks 0/1 · Build"]);
		session.setActiveToolsByName(["read"]);
		expect(panel.render(80)).toEqual([]);
		session.setActiveToolsByName(["todo_write"]);
		expect(panel.render(80)).toEqual(["Tasks 0/1 · Build"]);
	});
	it("settlement renders the mounted core chrome after clearing completed retention", async () => {
		const { session, settings } = await setup();
		session.sessionManager.appendCustomEntry("todo", tasks);
		const panel = new TaskPanelComponent({ getSession: () => session, getSettings: () => settings });
		const above = new Container();
		above.addChild(panel);
		panel.render(80);
		panel.handleEvent({ type: "agent_start" });
		session.sessionManager.appendCustomEntry("todo", [{ content: "Build", status: "completed" }]);
		expect(above.render(80)).toEqual(["Tasks 1/1"]);
		let displayed: string[] = [];
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session },
			isInitialized: true,
			taskPanel: panel,
			footer: { invalidate: vi.fn() },
			ui: {
				requestRender: () => {
					displayed = above.render(80);
				},
			},
			checkShutdownRequested: vi.fn(),
		});
		await Reflect.get(InteractiveMode.prototype, "handleEvent").call(mode, { type: "agent_settled" });
		expect(displayed).toEqual([]);
	});

	it("persists expansion globally without altering task entries", async () => {
		const { session, settings } = await setup();
		const before = session.sessionManager.getEntries();
		const panel = new TaskPanelComponent({ getSession: () => session, getSettings: () => settings });
		expect(settings.getTaskPanelExpanded()).toBe(false);
		panel.toggle();
		await settings.flush();
		const fresh = SettingsManager.create(cwd, join(cwd, "agent"), { projectTrusted: true });
		expect(fresh.getTaskPanelExpanded()).toBe(true);
		expect(session.sessionManager.getEntries()).toEqual(before);
	});
});
