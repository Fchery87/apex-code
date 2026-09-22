import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { hintRow } from "../src/modes/interactive/components/keybinding-hints.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("hintRow", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders lower-case key-action pairs in one grammar", () => {
		setKeybindings(new KeybindingsManager());

		const row = hintRow([
			[["tui.select.up", "tui.select.down"], "move"],
			["tui.select.confirm", "select"],
			[{ literal: "ctrl+s" }, "set as default"],
			["tui.select.cancel", "close"],
		]);

		expect(stripAnsi(row)).toBe("up/down move · enter select · ctrl+s set as default · escape/ctrl+c close");
	});

	test("names the key the user bound, not the default", () => {
		setKeybindings(new KeybindingsManager({ "tui.select.confirm": "ctrl+j" }));

		expect(stripAnsi(hintRow([["tui.select.confirm", "select"]]))).toBe("ctrl+j select");

		setKeybindings(new KeybindingsManager());
	});

	test("uses an ASCII separator under the ASCII symbol preset", () => {
		setKeybindings(new KeybindingsManager());

		expect(
			stripAnsi(
				hintRow(
					[
						["tui.select.confirm", "select"],
						["tui.select.cancel", "close"],
					],
					{ ascii: true },
				),
			),
		).toBe("enter select - escape/ctrl+c close");
	});
});
