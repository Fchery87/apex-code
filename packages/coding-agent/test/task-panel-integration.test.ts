import { Container, matchesKey, setKeybindings, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
describe("task chrome integration", () => {
	it("registers a collision-free tasks key and command", () => {
		expect(KEYBINDINGS["app.tasks.toggle"]?.defaultKeys).toBe("alt+j");
		expect(matchesKey("\x1bj", "alt+j")).toBe(true);
		expect(
			Object.entries(KEYBINDINGS).filter(
				([name, value]) =>
					name !== "app.tasks.toggle" && [value.defaultKeys].flat().some((key) => String(key) === "alt+j"),
			),
		).toEqual([]);
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "tasks")?.description).toContain("task");
	});
	it("keeps core panel mounted through extension widget replacement", () => {
		const core = new Container();
		core.addChild(new Text("Tasks 1/2", 0, 0));
		const above = new Container();
		above.addChild(core);
		const extensions = new Container();
		above.addChild(extensions);
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			ui: { requestRender: vi.fn() },
			widgetContainerAbove: above,
			extensionWidgetContainerAbove: extensions,
			widgetContainerBelow: new Container(),
			extensionWidgetsAbove: new Map([["one", new Text("Widget", 0, 0)]]),
			extensionWidgetsBelow: new Map(),
		});
		Reflect.get(InteractiveMode.prototype, "renderWidgets").call(mode);
		expect(stripAnsi(above.render(80).join("\n"))).toContain("Tasks 1/2");
		expect(stripAnsi(above.render(80).join("\n"))).toContain("Widget");
		mode.extensionWidgetsAbove.clear();
		Reflect.get(InteractiveMode.prototype, "renderWidgets").call(mode);
		expect(stripAnsi(above.render(80).join("\n"))).toContain("Tasks 1/2");
	});
	it("renders one compact result, expanded task disclosure, and actual errors", () => {
		const definition: ToolDefinition = {
			name: "todo_write",
			label: "todo_write",
			description: "tasks",
			parameters: Type.Any(),
			execute: async () => ({ content: [], details: {} }),
		};
		const component = new ToolExecutionComponent(
			"todo_write",
			"tasks-id",
			{},
			{},
			withBuiltInRenderers("todo_write", definition) as typeof definition,
			{ requestRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{
				content: [{ type: "text", text: "verbose result" }],
				details: {
					todos: [
						{ content: "Read", status: "completed" },
						{ content: "Implement", status: "in_progress" },
					],
				},
				isError: false,
			},
			false,
		);
		let output = stripAnsi(component.render(80).join("\n"));
		expect(output.match(/Task list updated/g) ?? []).toHaveLength(1);
		expect(output).toContain("Task list updated · 1/2 complete");
		expect(output).not.toContain("verbose result");
		expect(output).not.toContain("Implement");
		const lines = component.render(80);
		expect(
			component.handleMouse({
				type: "click",
				button: "left",
				x: 2,
				y: 1,
				screenX: 2,
				screenY: 1,
				width: 80,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			})?.handled,
		).toBe(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("› Implement");
		component.setExpanded(false);
		const chat = new Container();
		chat.addChild(component);
		const actions = new Map<string, () => void>();
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			chatDetail: "overview",
			chatContainer: chat,
			loadedResourcesContainer: new Container(),
			defaultEditor: { onAction: (name: string, handler: () => void) => actions.set(name, handler) },
			runtimeHost: { session: { settingsManager: { setChatDetail: vi.fn() } } },
			ui: { requestRender: vi.fn() },
			showStatus: vi.fn(),
		});
		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		actions.get("app.tools.expand")?.();
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("› Implement");
		actions.get("app.tools.expand")?.();
		expect(stripAnsi(component.render(80).join("\n"))).toContain("› Implement");
		component.updateResult(
			{ content: [{ type: "text", text: "Disk cannot persist tasks" }], details: {}, isError: true },
			false,
		);
		output = stripAnsi(component.render(80).join("\n"));
		expect(output).toContain("Disk cannot persist tasks");
		expect(output).not.toContain("Task list updated");
	});
	it("forwards settlement and schedules a frame to clear completed chrome", async () => {
		const taskPanel = { handleEvent: vi.fn() };
		const requestRender = vi.fn();
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			isInitialized: true,
			taskPanel,
			footer: { invalidate: vi.fn() },
			ui: { requestRender },
			checkShutdownRequested: vi.fn(),
		});
		await Reflect.get(InteractiveMode.prototype, "handleEvent").call(mode, { type: "agent_settled" });
		expect(taskPanel.handleEvent).toHaveBeenCalledWith({ type: "agent_settled" });
		expect(requestRender).toHaveBeenCalled();
	});

	it("routes /tasks and the resolved editor action to the same toggle", async () => {
		const actions = new Map<string, () => void>();
		const toggle = vi.fn();
		const editor = {
			setText: vi.fn(),
			onAction: (name: string, handler: () => void) => actions.set(name, handler),
			onSubmit: undefined as undefined | ((text: string) => Promise<void>),
		};
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			defaultEditor: editor,
			editor,
			taskPanel: { toggle },
			ui: { requestRender: vi.fn() },
		});
		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler").call(mode);
		actions.get("app.tasks.toggle")?.();
		await editor.onSubmit?.(" /tasks ");
		expect(toggle).toHaveBeenCalledTimes(2);
		expect(editor.setText).toHaveBeenCalledWith("");
	});

	it("preserves extension renderer precedence", () => {
		const custom = () => new Text("Custom tasks", 0, 0);
		expect(withBuiltInRenderers("todo_write", { renderCall: custom, renderResult: custom })).toMatchObject({
			renderCall: custom,
			renderResult: custom,
		});
	});
});
