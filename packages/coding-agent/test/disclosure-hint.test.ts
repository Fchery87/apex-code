import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { formatHiddenLines, previewLineCount } from "../src/modes/interactive/components/keybinding-hints.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("counted disclosure hint", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("names the hidden count and the expand key in one shape", () => {
		expect(stripAnsi(formatHiddenLines(12, "more"))).toBe("... (12 more lines, ctrl+o to expand)");
		expect(stripAnsi(formatHiddenLines(35, "earlier"))).toBe("... (35 earlier lines, ctrl+o to expand)");
	});

	test("counts a body collapsed to nothing without calling it more", () => {
		expect(stripAnsi(formatHiddenLines(3, "all"))).toBe("... (3 lines, ctrl+o to expand)");
	});

	test("uses the singular for one line", () => {
		expect(stripAnsi(formatHiddenLines(1, "earlier"))).toBe("... (1 earlier line, ctrl+o to expand)");
	});

	test("says nothing when nothing is hidden", () => {
		expect(formatHiddenLines(0, "more")).toBe("");
	});

	test("never hides a single line behind a hint that costs the same row", () => {
		expect(previewLineCount(6, 5)).toBe(6);
		expect(previewLineCount(7, 5)).toBe(5);
		expect(previewLineCount(3, 5)).toBe(3);
	});
});
