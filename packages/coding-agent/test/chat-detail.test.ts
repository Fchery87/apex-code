import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import {
	type ChatDetail,
	chatDetailView,
	INITIAL_CHAT_DETAIL,
	nextChatDetail,
} from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ALL_DETAILS: ChatDetail[] = ["overview", "details", "all"];

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

/**
 * Wide enough that the rendered file path never wraps.
 *
 * The header carries an absolute path, and a temp directory is far longer on
 * macOS than on Linux. At a narrow width the wrap point is length-dependent and
 * lands mid-filename there, which split `greet.ts` across two lines and failed
 * only on that platform. Nothing here is about narrow layout, so give it room.
 */
const RENDER_WIDTH = 200;

function render(component: ToolExecutionComponent): string {
	return stripAnsi(component.render(RENDER_WIDTH).join("\n"));
}

describe("conversation detail cycle", () => {
	it("cycles overview, details, all, and wraps", () => {
		expect(nextChatDetail("overview")).toBe("details");
		expect(nextChatDetail("details")).toBe("all");
		expect(nextChatDetail("all")).toBe("overview");
	});

	it("returns to where it started after one full cycle", () => {
		for (const start of ALL_DETAILS) {
			expect(nextChatDetail(nextChatDetail(nextChatDetail(start)))).toBe(start);
		}
	});

	it("reveals diffs one rung before it expands tool output", () => {
		expect(chatDetailView("overview")).toEqual({
			toolOutputExpanded: false,
			editDiffsExpanded: false,
			thinking: "collapsed",
		});
		expect(chatDetailView("details")).toEqual({
			toolOutputExpanded: false,
			editDiffsExpanded: true,
			thinking: "preference",
		});
		expect(chatDetailView("all")).toEqual({
			toolOutputExpanded: true,
			editDiffsExpanded: true,
			thinking: "revealed",
		});
	});

	it("gives every rung a distinct reading", () => {
		const seen = ALL_DETAILS.map((detail) => JSON.stringify(chatDetailView(detail)));
		expect(new Set(seen).size).toBe(ALL_DETAILS.length);
	});

	it("defers to the thinking preference only at the middle rung", () => {
		// Overview collapses thinking and all reveals it; neither is written back to settings.
		expect(ALL_DETAILS.filter((detail) => chatDetailView(detail).thinking === "preference")).toEqual(["details"]);
	});

	it("starts a session with everything collapsed", () => {
		expect(INITIAL_CHAT_DETAIL).toBe("overview");
		expect(chatDetailView(INITIAL_CHAT_DETAIL)).toEqual({
			toolOutputExpanded: false,
			editDiffsExpanded: false,
			thinking: "collapsed",
		});
	});
});

describe("edit diffs under the detail cycle", () => {
	let dir: string | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		dir = undefined;
	});

	async function renderEditAt(editDiffsExpanded: boolean): Promise<string> {
		dir = mkdtempSync(join(tmpdir(), "chat-detail-"));
		const file = join(dir, "greet.ts");
		writeFileSync(file, 'export function greet(name: string) {\n\treturn "hi " + name;\n}\n');
		const definition = createEditToolDefinition(dir) as any;
		const args = { path: file, edits: [{ oldText: '"hi " + name', newText: '"hello, " + name + "!"' }] };
		const component = new ToolExecutionComponent("edit", "t1", args, {}, definition, createFakeTui(), dir);
		component.setArgsComplete();
		component.markExecutionStarted();
		component.updateResult(await definition.execute("t1", args), false);
		// The call renderer computes its diff preview asynchronously.
		await vi.waitFor(() => expect(render(component)).toContain("greet.ts"));
		component.setEditDiffsExpanded(editDiffsExpanded);
		return render(component);
	}

	it("reduces a diff to its line counts when diffs are collapsed", async () => {
		const rendered = await renderEditAt(false);

		expect(rendered).toContain("+1 -1");
		expect(rendered).not.toContain('"hello, " + name');
	});

	it("shows the diff when they are not", async () => {
		const rendered = await renderEditAt(true);

		expect(rendered).toContain('"hello, " + name');
		expect(rendered).not.toContain("+1 -1");
	});

	it("names the file at every rung, so a collapsed edit is still an edit", async () => {
		expect(await renderEditAt(false)).toContain("greet.ts");
		expect(await renderEditAt(true)).toContain("greet.ts");
	});
});
