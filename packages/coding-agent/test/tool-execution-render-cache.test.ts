import { type Component, Container, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/**
 * ToolExecutionComponent must cache its composed lines between frames.
 *
 * Before the cache, every frame recomposed the panel wrapper (ANSI-aware
 * truncate + width measure + background paint per content line) for every
 * tool on screen, which made per-frame cost grow with transcript size and
 * blew the 16 ms frame budget on tool-heavy sessions (measured at up to
 * 314 ms/frame with 300 history messages).
 *
 * These tests observe caching through the public tool-definition seam: the
 * wrapped renderers are components that count their own render() calls. With
 * a correct cache, repeated frames at unchanged state and width reuse the
 * composed lines and the wrapped renderers are not re-rendered.
 */

class RecordingTerminal implements Terminal {
	columns = 100;
	rows = 30;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class CountingComponent implements Component {
	calls = 0;
	private readonly lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(_width: number): string[] {
		this.calls += 1;
		return this.lines;
	}
	invalidate(): void {}
}

function createCountingToolDefinition(): {
	definition: ToolDefinition<any, any>;
	callRenderer: CountingComponent;
	resultRenderer: CountingComponent;
} {
	const callRenderer = new CountingComponent(["read /tmp/example.ts"]);
	const resultRenderer = new CountingComponent(["file body line"]);
	const definition = {
		name: "read",
		label: "Read",
		description: "counting renderer",
		renderCall: () => callRenderer,
		renderResult: () => resultRenderer,
	} as unknown as ToolDefinition<any, any>;
	return { definition, callRenderer, resultRenderer };
}

describe("ToolExecutionComponent render caching", () => {
	let terminal: RecordingTerminal;
	let tui: TUI;
	let root: Container;

	beforeEach(() => {
		initTheme("dark");
		terminal = new RecordingTerminal();
		tui = new TuiMainScreen(terminal);
		root = new Container();
		tui.addChild(root);
		tui.start();
	});

	function createComponent(definition: ToolDefinition<any, any>): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			"read",
			"tool-call-cache-1",
			{ path: "/tmp/example.ts" },
			{},
			definition,
			tui,
			"/tmp",
		);
		root.addChild(component);
		return component;
	}

	it("does not re-render wrapped renderers when state and width are unchanged", () => {
		const { definition, callRenderer, resultRenderer } = createCountingToolDefinition();
		createComponent(definition);

		tui.renderNow();
		const callsAfterFirstFrame = callRenderer.calls + resultRenderer.calls;
		expect(callsAfterFirstFrame).toBeGreaterThan(0);

		// Ten more frames at the same state and width: the composed lines are cached.
		for (let i = 0; i < 10; i++) {
			tui.renderNow();
		}
		expect(callRenderer.calls + resultRenderer.calls).toBe(callsAfterFirstFrame);
	});

	it("re-renders when the result arrives", () => {
		const { definition, callRenderer, resultRenderer } = createCountingToolDefinition();
		const component = createComponent(definition);
		tui.renderNow();
		const before = callRenderer.calls + resultRenderer.calls;

		component.setArgsComplete();
		tui.renderNow();
		expect(callRenderer.calls + resultRenderer.calls).toBeGreaterThan(before);
	});

	it("re-renders when expansion toggles", () => {
		const { definition, callRenderer, resultRenderer } = createCountingToolDefinition();
		const component = createComponent(definition);
		component.setArgsComplete();
		component.updateResult({ content: [{ type: "text", text: "out" }], isError: false });
		tui.renderNow();
		const before = callRenderer.calls + resultRenderer.calls;

		component.setExpanded(true);
		tui.renderNow();
		expect(callRenderer.calls + resultRenderer.calls).toBeGreaterThan(before);
	});

	it("re-renders when the width changes", () => {
		const { definition, callRenderer, resultRenderer } = createCountingToolDefinition();
		createComponent(definition);
		tui.renderNow();
		const before = callRenderer.calls + resultRenderer.calls;

		terminal.columns = 80;
		tui.renderNow();
		expect(callRenderer.calls + resultRenderer.calls).toBeGreaterThan(before);
	});

	it("keeps rendered output identical when served from the cache", () => {
		const { definition } = createCountingToolDefinition();
		const component = createComponent(definition);
		tui.renderNow();
		const first = component.render(100);
		const second = component.render(100);
		expect(second).toEqual(first);
	});
});
