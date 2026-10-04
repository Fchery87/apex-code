import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { setKeybindings } from "@earendil-works/pi-tui";
import { Agent } from "apex-code-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
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
async function setup(
	options: {
		manager?: SessionManager;
		extensions?: ExtensionFactory[];
		tools?: string[];
		defaults?: string[];
		excludeTools?: string[];
		noTools?: "all" | "builtin";
		configured?: boolean;
		projectDefaults?: string[];
	} = {},
) {
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir, { recursive: true });
	if (options.defaults)
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: options.defaults }));
	if (options.projectDefaults) {
		mkdirSync(join(cwd, ".apex-code"), { recursive: true });
		writeFileSync(
			join(cwd, ".apex-code", "settings.json"),
			JSON.stringify({ defaultTools: options.projectDefaults }),
		);
	}
	if (options.configured)
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { test: { command: "does-not-run", lifecycle: "lazy" } } }),
		);
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
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		lspOperations: options.configured ? { request: async () => [] } : undefined,
		webSearchOperations: options.configured ? { search: async () => [] } : undefined,
	});
	sessions.push(session);
	return { session, settings, faux };
}

async function selectorFor(session: AgentSession) {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	let selector: SettingsSelectorComponent | undefined;
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session },
		themeController: { getThemeSelection: () => "dark", getTerminalTheme: () => "dark" },
		chatDetail: "overview",
		hideThinkingBlock: false,
		ui: { mode: "main", requestRender: () => {} },
		showSelector: (factory: (done: () => void) => { component: SettingsSelectorComponent }) => {
			selector = factory(() => {}).component;
		},
	});
	await Reflect.get(InteractiveMode.prototype, "showSettingsSelector").call(mode);
	if (!selector) throw new Error("Settings selector was not mounted");
	return selector.getSettingsList();
}
describe("future task tool defaults", () => {
	it("captures configured construction defaults before restrictive CLI selections", async () => {
		const { session } = await setup({ configured: true, tools: ["read"] });
		expect(session.getImplicitDefaultToolNames()).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"lsp",
			"web_search",
			"mcp",
		]);
		const names = session.getImplicitDefaultToolNames();
		names.length = 0;
		expect(session.getImplicitDefaultToolNames()).toHaveLength(7);
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});
	it("persists defensive default arrays globally", async () => {
		const { settings } = await setup();
		const names = ["read", "custom", "todo_write"];
		settings.setDefaultTools(names);
		names.length = 0;
		await settings.flush();
		expect(settings.getDefaultTools()).toEqual(["read", "custom", "todo_write"]);
		const fresh = SettingsManager.create(cwd, join(cwd, "agent"), { projectTrusted: true });
		expect(fresh.getDefaultTools()).toEqual(["read", "custom", "todo_write"]);
	});
	it("toggles the actual row from unset configured defaults for future sessions only", async () => {
		const { session, settings } = await setup({ configured: true, tools: ["read"] });
		const list = await selectorFor(session);
		list.selectItem("task-list-tool");
		expect(stripAnsi(list.render(120).join("\n"))).toContain("Task-list tool");
		list.handleInput("\r");
		expect(settings.getDefaultTools()).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"lsp",
			"web_search",
			"mcp",
			"todo_write",
		]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		await session.reload();
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});
	it("keeps project-controlled defaults read-only with an explanation", async () => {
		const { session, settings } = await setup({ defaults: ["bash"], projectDefaults: ["read", "todo_write"] });
		const list = await selectorFor(session);
		list.selectItem("task-list-tool");
		const output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("project defaultTools");
		list.handleInput("\r");
		expect(settings.getGlobalSettings().defaultTools).toEqual(["bash"]);
		expect(settings.getDefaultTools()).toEqual(["read", "todo_write"]);
	});
	it("preserves explicit arrays and removes every todo occurrence on disable", async () => {
		const names = ["custom_tool", "todo_write", "read", "todo_write", "web_fetch"];
		const { session, settings } = await setup({ defaults: names });
		const list = await selectorFor(session);
		list.selectItem("task-list-tool");
		list.handleInput("\r");
		expect(settings.getDefaultTools()).toEqual(["custom_tool", "read", "web_fetch"]);
		list.handleInput("\r");
		expect(settings.getDefaultTools()).toEqual(["custom_tool", "read", "web_fetch", "todo_write"]);
	});
	it("enables new sessions while explicit tools, exclusions and noTools remain authoritative", async () => {
		const { session, settings } = await setup();
		expect(session.getActiveToolNames()).not.toContain("todo_write");
		const list = await selectorFor(session);
		list.selectItem("task-list-tool");
		list.handleInput("\r");
		await settings.flush();
		const future = await setup();
		expect(future.session.getActiveToolNames()).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"todo_write",
			"tool_schema",
		]);
		for (const options of [
			{ tools: ["read"] },
			{ excludeTools: ["todo_write"] },
			{ noTools: "all" as const },
			{ noTools: "builtin" as const },
		]) {
			const restricted = await setup(options);
			expect(restricted.session.getActiveToolNames()).not.toContain("todo_write");
		}
	});
	it("seeds original defaults even when SDK initial tools are empty", async () => {
		const { session, settings } = await setup({ noTools: "all", configured: true });
		expect(session.getActiveToolNames()).toEqual([]);
		const list = await selectorFor(session);
		list.selectItem("task-list-tool");
		list.handleInput("\r");
		expect(settings.getDefaultTools()).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"lsp",
			"web_search",
			"mcp",
			"todo_write",
		]);
		expect(session.getActiveToolNames()).toEqual([]);
	});
	it("keeps low-level construction at core-plus-LSP and respects base overrides", async () => {
		const original = await setup();
		const model = original.session.model;
		if (!model) throw new Error("Missing faux model");
		const common = {
			settingsManager: original.settings,
			cwd,
			modelRuntime: original.session.modelRuntime,
			resourceLoader: createTestResourceLoader(),
			lspOperations: { request: async () => [] },
			webSearchOperations: { search: async () => [] },
		};
		const plain = new AgentSession({
			...common,
			agent: new Agent({ streamFn: streamSimple, initialState: { model } }),
			sessionManager: SessionManager.inMemory(cwd),
		});
		sessions.push(plain);
		expect(plain.getImplicitDefaultToolNames()).toEqual(["read", "bash", "edit", "write", "lsp"]);
		expect(plain.getActiveToolNames()).toEqual(["read", "bash", "edit", "write", "lsp", "tool_schema"]);
		const read = original.session.agent.state.tools.find((tool) => tool.name === "read");
		if (!read) throw new Error("Missing read tool");
		const custom = new AgentSession({
			...common,
			agent: new Agent({ streamFn: streamSimple, initialState: { model } }),
			sessionManager: SessionManager.inMemory(cwd),
			baseToolsOverride: { read },
		});
		sessions.push(custom);
		expect(custom.getImplicitDefaultToolNames()).toEqual(["read"]);
		expect(custom.getActiveToolNames()).toEqual(["read"]);
	});
});
