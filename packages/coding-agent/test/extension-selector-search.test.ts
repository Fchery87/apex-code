import { describe, expect, it } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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
});
