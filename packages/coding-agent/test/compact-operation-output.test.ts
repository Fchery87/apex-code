import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resetCapabilitiesCache,
	setCapabilities,
	Text,
	type TUI,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { ToolExecutionComponent, type ToolRenderers } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ui = { requestRender() {}, start() {}, stop() {} } as unknown as TUI;
function tool(name = "write", definition?: ToolRenderers) {
	const component = new ToolExecutionComponent(
		name,
		"compact",
		{ path: "src/世界.ts", content: "private payload\nsecond line" },
		{},
		definition,
		ui,
		process.cwd(),
	);
	component.setChatDetail("overview");
	return component;
}
function click(component: ToolExecutionComponent | BashExecutionComponent, y = 0) {
	const height = component.render(100).length;
	return component.handleMouse({
		type: "click",
		button: "left",
		x: 0,
		y,
		screenX: 0,
		screenY: 0,
		width: 100,
		height,
	} as TuiMouseEvent);
}
beforeAll(() => initTheme("dark"));
afterEach(() => resetCapabilitiesCache());
describe("compact operation overview", () => {
	it("counts internal blank output lines without counting the trailing newline", () => {
		const output = "first\n\nthird\n";
		const component = tool("unknown");
		component.updateResult({ content: [{ type: "text", text: output }], isError: false });
		expect(stripAnsi(component.render(150)[0])).toContain("3 output lines");
		const shell = new BashExecutionComponent("printf output", ui);
		shell.setChatDetail("overview");
		shell.appendOutput(output);
		shell.setComplete(0, false);
		expect(stripAnsi(shell.render(150)[0])).toContain("3 output lines");
	});
	it("bounds generic arguments and output to one physical row at narrow Unicode widths", () => {
		const component = tool();
		component.updateResult({ content: [{ type: "text", text: "secret result\nmore" }], isError: false });
		for (const width of [1, 5, 20, 100]) {
			const lines = component.render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
			expect(stripAnsi(lines[0])).not.toContain("private payload");
			expect(stripAnsi(lines[0])).not.toContain("secret result");
		}
		expect(stripAnsi(component.render(100)[0])).toContain("src/世界.ts");
		click(component);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("secret result");
	});
	it("compacts self-rendering extensions while preserving their call labels and hidden results", () => {
		const component = tool("custom", {
			renderShell: "self",
			renderCall: () => new Text("Deploy service\nlarge preview", 0, 0),
			renderResult: () => ({ render: () => [], invalidate() {} }),
		});
		component.updateResult({ content: [{ type: "text", text: "hidden output" }], isError: false });
		expect(component.render(100)).toHaveLength(1);
		expect(stripAnsi(component.render(100)[0])).toContain("Deploy service");
		expect(stripAnsi(component.render(100)[0])).not.toContain("hidden output");
	});
	it("shows an error diagnostic and hides image payloads in overview", () => {
		const component = tool("image");
		component.updateResult({
			content: [
				{ type: "text", text: "Permission denied\nstack trace" },
				{ type: "image", data: "payload", mimeType: "image/png" },
			],
			isError: true,
		});
		expect(component.render(100)).toHaveLength(1);
		expect(stripAnsi(component.render(100)[0])).toContain("Permission denied");
		expect(stripAnsi(component.render(100)[0])).not.toContain("stack trace");
	});
	it("keeps queued and streaming operations on one row", () => {
		const component = tool("bash");
		expect(component.render(80)).toHaveLength(1);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "line\nline\nline" }], isError: false }, true);
		expect(component.render(80)).toHaveLength(1);
		expect(stripAnsi(component.render(80)[0])).toContain("running");
		component.dispose();
	});
	it("compacts user shell output and allows row-zero expansion", () => {
		const component = new BashExecutionComponent("printf 'long\ncommand'", ui);
		component.setChatDetail("overview");
		component.appendOutput("first\nsecond\n");
		component.setComplete(1, false);
		expect(component.render(100)).toHaveLength(1);
		expect(stripAnsi(component.render(100)[0])).toContain("exit 1");
		click(component);
		expect(stripAnsi(component.render(100).join("\n"))).toContain("second");
	});
});

describe("compact operation coverage", () => {
	it.each(["read", "write", "grep", "bash", "find", "ls"])("compacts built-in %s previews", (name) => {
		const component = tool(name, withBuiltInRenderers(name, undefined));
		component.updateResult({
			content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `output ${i}`).join("\n") }],
			isError: false,
		});
		expect(component.render(100)).toHaveLength(1);
		expect(stripAnsi(component.render(100)[0])).not.toContain("output 0");
		expect(stripAnsi(component.render(100)[0])).not.toContain("to expand");
		component.setChatDetail("all");
		expect(component.render(100).length).toBeGreaterThan(1);
	});
	it("keeps fully hidden extensions hidden", () => {
		const hidden = () => ({ render: () => [], invalidate() {} });
		const component = tool("hidden", { renderShell: "self", renderCall: hidden, renderResult: hidden });
		component.updateResult({ content: [{ type: "text", text: "secret" }], isError: false });
		expect(component.render(100)).toEqual([]);
	});
	it("retains complete unknown-tool arguments in all and resets individual expansion", () => {
		const component = tool("unknown");
		component.updateResult({ content: [{ type: "text", text: "details" }], isError: false });
		component.toggleExpanded();
		expect(stripAnsi(component.render(100).join("\n"))).toContain("private payload");
		component.setChatDetail("overview");
		expect(component.render(100)).toHaveLength(1);
	});
	it("reveals image output on expansion", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const component = tool("image");
		component.updateResult({
			content: [
				{
					type: "image",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
					mimeType: "image/png",
				},
			],
			isError: false,
		});
		expect(component.render(100)).toHaveLength(1);
		expect(stripAnsi(component.render(100)[0])).toContain("1 image");
		component.toggleExpanded();
		expect(component.render(100).join("\n")).toContain("\x1b_G");
	});
	it("reveals an actual edit diff when its overview row is clicked", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "compact-edit-"));
		try {
			const path = join(scratch, "greeting.ts");
			writeFileSync(path, 'const greeting = "hello";\n');
			const definition = createEditToolDefinition(scratch);
			const args = { path, edits: [{ oldText: '"hello"', newText: '"welcome"' }] };
			const component = new ToolExecutionComponent("edit", "edit", args, {}, definition, ui, scratch);
			component.setChatDetail("overview");
			component.setArgsComplete();
			const result = await createEditTool(scratch).execute("edit", args);
			component.updateResult({ ...result, isError: false });
			expect(component.render(200)).toHaveLength(1);
			click(component);
			await vi.waitFor(() => expect(stripAnsi(component.render(200).join("\n"))).toContain('"welcome"'));
			component.dispose();
		} finally {
			rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
		}
	});
	it("keeps running and cancelled user shells bounded", () => {
		const component = new BashExecutionComponent("echo 世界\nlong command", ui, false, "ascii");
		component.setChatDetail("overview");
		component.appendOutput("partial output");
		for (const width of [1, 10, 80]) {
			expect(component.render(width)).toHaveLength(1);
			expect(visibleWidth(component.render(width)[0])).toBeLessThanOrEqual(width);
		}
		component.setComplete(undefined, true);
		expect(stripAnsi(component.render(100)[0])).toContain("cancelled");
	});
	it("selects failure diagnostics after successful progress output", () => {
		const output = "PASS auth.test.ts\nFAIL session.test.ts\nError: assertion failed";
		const component = tool("bash");
		component.updateResult({ content: [{ type: "text", text: output }], isError: true });
		expect(stripAnsi(component.render(150)[0])).toContain("Error: assertion failed");
		expect(stripAnsi(component.render(150)[0])).not.toContain("PASS");
		const shell = new BashExecutionComponent("npm test", ui);
		shell.setChatDetail("overview");
		shell.appendOutput(output);
		shell.setComplete(1, false);
		expect(stripAnsi(shell.render(150)[0])).toContain("Error: assertion failed");
	});
});

it("allows inspection of queued arguments by clicking the overview row", () => {
	const component = tool("unknown");
	click(component);
	expect(stripAnsi(component.render(100).join("\n"))).toContain("private payload");
});

it("leaves expanded queued arguments available for selection", () => {
	const component = tool("unknown");
	click(component);
	const expanded = component.render(100);
	const argumentRow = expanded.findIndex((line) => stripAnsi(line).includes("private payload"));
	expect(argumentRow).toBeGreaterThan(0);
	expect(click(component, argumentRow)).toBeUndefined();
	expect(component.render(100)).toEqual(expanded);
});

it("toggles an expanded user shell only from its command header", () => {
	const shell = new BashExecutionComponent("echo full", ui);
	shell.setChatDetail("overview");
	shell.appendOutput("complete shell output");
	shell.setComplete(0, false);
	expect(click(shell)?.handled).toBe(true);
	const expanded = shell.render(100);
	const headerRow = expanded.findIndex((line) => stripAnsi(line).includes("$ echo full"));
	const outputRow = expanded.findIndex((line) => stripAnsi(line).includes("complete shell output"));
	for (const row of [0, 1, outputRow, expanded.length - 1]) {
		expect(click(shell, row)).toBeUndefined();
		expect(shell.render(100)).toEqual(expanded);
	}
	expect(click(shell, headerRow)?.handled).toBe(true);
	expect(shell.render(100)).toHaveLength(1);
});

it("retains failure state and diagnostic when a long command consumes the label width", () => {
	const shell = new BashExecutionComponent(`run ${"long/path/".repeat(20)}`, ui);
	shell.setChatDetail("overview");
	shell.appendOutput("Error: permission denied");
	shell.setComplete(2, false);
	const row = stripAnsi(shell.render(80)[0]);
	expect(row).toContain("error");
	expect(row).toContain("exit 2");
	expect(row).toContain("permission denied");
	expect(visibleWidth(row)).toBeLessThanOrEqual(80);
});

it("collapses an individual operation from all back to one row and reopens it", () => {
	const component = tool("unknown");
	component.updateResult({ content: [{ type: "text", text: "complete tool output" }], isError: false });
	const shell = new BashExecutionComponent("echo full", ui);
	shell.appendOutput("complete shell output");
	shell.setComplete(0, false);
	for (const operation of [component, shell]) {
		operation.setChatDetail("all");
		operation.toggleExpanded();
		expect(operation.render(100)).toHaveLength(1);
		click(operation);
		expect(stripAnsi(operation.render(100).join("\n"))).toContain("complete");
		operation.setChatDetail("details");
		expect(operation.render(100).length).toBeGreaterThan(1);
	}
});
