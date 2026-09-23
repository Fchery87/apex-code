import { describe, expect, test } from "vitest";
import { PromptInput } from "../src/modes/interactive/components/prompt-input.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("PromptInput", () => {
	test("draws the composer's prompt glyph at the same width as the one it replaces", () => {
		initTheme("dark");
		const input = new PromptInput();
		input.setValue("deep");

		const [line] = input.render(20).map((rendered) => stripAnsi(rendered));

		expect(line.startsWith("› deep")).toBe(true);
		expect(line).not.toContain(">");
	});
});
