import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { type ChatDetail, chatDetailView, nextChatDetail } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ALL_DETAILS: ChatDetail[] = ["overview", "details", "all"];

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
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
			revealThinking: false,
		});
		expect(chatDetailView("details")).toEqual({
			toolOutputExpanded: false,
			editDiffsExpanded: true,
			revealThinking: false,
		});
		expect(chatDetailView("all")).toEqual({
			toolOutputExpanded: true,
			editDiffsExpanded: true,
			revealThinking: true,
		});
	});

	it("gives every rung a distinct reading", () => {
		const seen = ALL_DETAILS.map((detail) => JSON.stringify(chatDetailView(detail)));
		expect(new Set(seen).size).toBe(ALL_DETAILS.length);
	});

	it("overrides a hidden-thinking preference only at the top rung", () => {
		// The cycle may reveal thinking, but never writes that back to settings,
		// so the preference still governs the two lower rungs.
		expect(ALL_DETAILS.filter((detail) => chatDetailView(detail).revealThinking)).toEqual(["all"]);
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
		await vi.waitFor(() => expect(stripAnsi(component.render(90).join("\n"))).toContain("greet.ts"));
		component.setEditDiffsExpanded(editDiffsExpanded);
		return stripAnsi(component.render(90).join("\n"));
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
