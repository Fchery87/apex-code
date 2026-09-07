import { describe, expect, it } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { accentOpen, paintedWidth, selectedRowOpen } from "./suite/theme-ansi.ts";

describe("ExtensionSelectorComponent search", () => {
	it("filters an opted-in selector by typed text", () => {
		initTheme("dark");
		const selector = new ExtensionSelectorComponent(
			"Configuration",
			["Settings", "Provider login", "Project trust"],
			() => {},
			() => {},
			{ enableSearch: true },
		);

		selector.handleInput("p");
		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("Provider login");
		expect(output).not.toContain("Settings");
	});

	it("lights the selected row with a background step, not with accent text", () => {
		initTheme("dark");
		const selector = new ExtensionSelectorComponent(
			"Configuration",
			["Settings", "Provider login", "Project trust"],
			() => {},
			() => {},
			{},
		);

		const selected = selector.render(120).find((line) => stripAnsi(line).includes("Settings"));

		expect(selected).toBeDefined();
		expect(selected).toContain(selectedRowOpen());
		expect(selected).not.toContain(accentOpen());
		// The fill hugs its text, matching the frozen SelectList it sits beside.
		expect(paintedWidth(selected ?? "")).toBeGreaterThan(0);
		expect(paintedWidth(selected ?? "")).toBeLessThan(120);
	});
});
