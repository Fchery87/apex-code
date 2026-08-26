import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CURSOR_MARKER = `${ESC}_pi:c${BEL}`;
const PLACEHOLDER = "Ask anything, / for commands, ! for bash";

/** stripAnsi leaves the APC cursor marker intact; drop it for text assertions. */
function plain(line: string): string {
	return stripAnsi(line.split(CURSOR_MARKER).join(""));
}

function makeEditor(options?: {
	placeholder?: string;
	promptPrefix?: string;
	focused?: boolean;
	paddingX?: number;
	surface?: boolean;
	autocomplete?: boolean;
}) {
	const tui = { terminal: { rows: 40, cols: 80 }, requestRender() {}, invalidate() {} };
	const editor = new CustomEditor(tui as never, getEditorTheme(), new KeybindingsManager(), {
		paddingX: options?.paddingX ?? 0,
		promptPrefix: options?.promptPrefix ?? "> ",
		promptColor: (text) => theme.fg("accent", text),
		placeholder: options?.placeholder ?? PLACEHOLDER,
		placeholderColor: (text) => theme.fg("dim", text),
		commandColor: (text) => theme.fg("accent", text),
		surfaceColor: options?.surface ? (text: string) => theme.bg("userMessageBg", text) : undefined,
		autocompleteRule: options?.autocomplete
			? (width: number) => theme.fg("borderMuted", "┄".repeat(width))
			: undefined,
		autocompleteFooter: options?.autocomplete ? () => theme.fg("dim", "tab complete") : undefined,
	});
	editor.focused = options?.focused ?? true;
	return editor;
}

const CURSOR_LEFT = `${ESC}[D`;

function userMessageBgOpen(): string {
	return theme.bg("userMessageBg", "x").replace(`x${ESC}[49m`, "");
}

/** Drive the caret leftwards through real key handling. */
function moveLeft(editor: CustomEditor, times: number): void {
	for (let index = 0; index < times; index++) {
		editor.handleInput(CURSOR_LEFT);
	}
}

describe("CustomEditor chrome", () => {
	beforeAll(() => {
		initTheme("apex", false);
	});

	describe("width safety", () => {
		// The editor renders into a fixed-width dock. The prompt prefix is carved
		// out of the width handed to the base Editor, so an off-by-one here
		// corrupts every frame.
		for (const width of [120, 80, 74, 60, 40, 20, 8, 6, 5, 3, 1]) {
			it(`emits no line wider than ${width} columns`, () => {
				const editor = makeEditor();
				for (const line of editor.render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			});
		}

		it("keeps lines exact-width once wrapped text fills the box", () => {
			const editor = makeEditor();
			editor.setText("x".repeat(400));
			for (const line of editor.render(74)) {
				expect(visibleWidth(line)).toBe(74);
			}
		});
	});

	describe("composer surface", () => {
		it("renders a borderless slab with two columns of horizontal breathing room", () => {
			const lines = makeEditor({ surface: true, focused: false }).render(60);

			expect(lines).toHaveLength(3);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(60);
				expect(line).toContain(userMessageBgOpen());
			}
			expect(plain(lines[0])).toBe(" ".repeat(60));
			expect(plain(lines[1]).startsWith("  > ")).toBe(true);
			expect(plain(lines[1])).toContain(PLACEHOLDER);
			expect(plain(lines[1]).endsWith("  ")).toBe(true);
			expect(plain(lines[2])).toBe(" ".repeat(60));
		});

		it("keeps the cursor marker and restores the surface after the cursor cell", () => {
			const line = makeEditor({ surface: true }).render(60)[1];

			expect(line).toContain(CURSOR_MARKER);
			const cursorCellEnd = line.indexOf(`${ESC}[7m ${ESC}[0m`) + `${ESC}[7m ${ESC}[0m`.length;
			expect(line.slice(cursorCellEnd)).toContain(userMessageBgOpen());
		});

		it("degrades its inset locally without overflowing narrow terminals", () => {
			for (const width of [120, 20, 8, 6, 5, 3, 2, 1]) {
				const lines = makeEditor({ surface: true }).render(width);
				for (const line of lines) {
					expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
				}
				expect(lines).toHaveLength(3);
				expect(plain(lines[0])).toBe(" ".repeat(width));
				expect(plain(lines[2])).toBe(" ".repeat(width));
			}
		});
	});

	describe("prompt prefix", () => {
		it("adds a text label for bash mode without overflowing the dock", () => {
			const editor = makeEditor();
			editor.setModeLabel("bash");
			for (const width of [120, 40]) {
				const lines = editor.render(width);
				expect(plain(lines[1])).toContain("bash");
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		});

		it("marks only the first input line, indenting continuations", () => {
			const editor = makeEditor();
			editor.setText("first line here\nsecond line here");
			const lines = editor.render(60).map(plain);

			expect(lines[1].startsWith("> first line here")).toBe(true);
			expect(lines[2].startsWith("  second line here")).toBe(true);
		});

		it("extends the borders across the reserved prefix columns", () => {
			const editor = makeEditor();
			const lines = editor.render(60).map(plain);
			// Top and bottom borders must be unbroken rules the full width.
			expect(lines[0]).toBe("─".repeat(60));
			expect(lines[lines.length - 1]).toBe("─".repeat(60));
		});

		it("drops the prefix rather than overflowing a very narrow terminal", () => {
			const editor = makeEditor();
			const lines = editor.render(5).map(plain);
			expect(lines[1].startsWith("> ")).toBe(false);
			for (const line of editor.render(5)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(5);
			}
		});
	});

	describe("placeholder", () => {
		it("fills the empty input line", () => {
			expect(plain(makeEditor().render(74)[1])).toContain(PLACEHOLDER);
		});

		it("disappears as soon as there is text", () => {
			const editor = makeEditor();
			editor.setText("hello");
			expect(plain(editor.render(74)[1])).not.toContain(PLACEHOLDER);
		});

		it("leaves the reverse-video cursor cell closed", () => {
			// A greedy leading-SGR match once swallowed the opening ESC[7m, which
			// rendered the whole placeholder — and the rest of the frame — inverted.
			const line = makeEditor().render(74)[1];
			const opens = line.split(`${ESC}[7m`).length - 1;
			const closes = line.split(`${ESC}[0m`).length - 1 + (line.split(`${ESC}[27m`).length - 1);
			expect(opens).toBe(1);
			expect(closes).toBeGreaterThanOrEqual(opens);
		});

		it("preserves the hardware-cursor marker so the cursor stays positioned", () => {
			expect(makeEditor().render(74)[1]).toContain(CURSOR_MARKER);
		});

		it("renders at full width when unfocused, where there is no cursor cell", () => {
			const editor = makeEditor({ focused: false });
			const line = editor.render(60)[1];
			expect(visibleWidth(line)).toBe(60);
			expect(plain(line)).toContain(PLACEHOLDER);
		});

		it("truncates rather than overflowing when the box is narrower than the text", () => {
			const editor = makeEditor({ placeholder: "a".repeat(200) });
			for (const line of editor.render(30)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(30);
			}
		});
	});

	describe("command colouring", () => {
		it("tints the command token but not its arguments", () => {
			const editor = makeEditor();
			editor.setText("/model something");
			const line = editor.render(50)[1];

			expect(line).toContain(theme.fg("accent", "/model"));
			// The argument must stay unstyled, so the highlight marks what is being
			// invoked rather than the whole line.
			expect(line).not.toContain(theme.fg("accent", "something"));
			expect(plain(line)).toContain("/model something");
		});

		it("leaves a line that is not a command untouched", () => {
			const editor = makeEditor();
			editor.setText("not a command");
			const line = editor.render(50)[1];
			// Only the prompt marker should carry the accent.
			expect(line.split(theme.fg("accent", "> ")).length - 1).toBe(1);
			expect(line).not.toContain(theme.fg("accent", "not"));
		});

		it("skips the indent and tints only the token", () => {
			const editor = makeEditor();
			editor.setText("  /help");
			const line = editor.render(50)[1];
			expect(line).toContain(theme.fg("accent", "/help"));
			expect(plain(line)).toContain("  /help");
		});

		it("keeps the token tinted when the cursor splits it", () => {
			// The caret's reverse-video cell lands mid-token and emits its own
			// ESC[0m, which would cancel a single wrap around the whole token.
			// Colour has to be re-opened after every control sequence.
			const editor = makeEditor();
			editor.setText("/model something");
			moveLeft(editor, 13); // caret to column 3, inside "/model"
			const line = editor.render(50)[1];

			expect(editor.getCursor()).toEqual({ line: 0, col: 3 });
			expect(line).toContain(theme.fg("accent", "/mo"));
			// The character under the caret is still part of the token.
			expect(line).toContain(theme.fg("accent", "d"));
			expect(plain(line)).toContain("/model something");
		});

		it("preserves line width with the cursor at every position in the token", () => {
			// Colouring splices SGR codes into the line; none of them may be counted
			// as visible columns.
			for (let offset = 0; offset <= 6; offset++) {
				const editor = makeEditor();
				editor.setText("/model something");
				moveLeft(editor, offset);
				for (const line of editor.render(50)) {
					expect(visibleWidth(line), `offset ${offset}`).toBe(50);
				}
			}
		});

		it("still renders the placeholder rather than a command on an empty line", () => {
			expect(plain(makeEditor().render(50)[1])).toContain(PLACEHOLDER);
		});
	});

	describe("border classification", () => {
		it("does not mistake typed box-drawing text for a border", () => {
			// render() tells the content region from the autocomplete region by
			// counting borders, so misreading one content line as a border shifts
			// every later line into the wrong region. A prefix test on "─" did.
			const editor = makeEditor();
			editor.setText("─notes on the design\nsecond line");
			const lines = editor.render(60).map(plain);

			expect(lines[1].startsWith("> ─notes")).toBe(true);
			expect(lines[2].startsWith("  second line")).toBe(true);
			// Exactly two real borders, top and bottom.
			expect(lines.filter((line) => /^─+$/.test(line))).toHaveLength(2);
		});

		it("keeps widths correct for a line of pure rule characters", () => {
			const editor = makeEditor();
			editor.setText("─".repeat(20));
			for (const line of editor.render(60)) {
				expect(visibleWidth(line)).toBe(60);
			}
		});
	});

	describe("unicode safety", () => {
		it("cuts the placeholder by display width, not by code unit count", () => {
			// "中" is the discriminating case: ONE UTF-16 code unit but TWO display
			// columns. String.slice(0, available) therefore yields `available`
			// characters occupying 2 x available columns, overflowing the box.
			// (An emoji is a poor test here — it is 2 units AND 2 columns, so the
			// two measures coincide and the bug hides.)
			const editor = makeEditor({ placeholder: "中".repeat(60) });
			for (const width of [50, 31, 30, 12, 7]) {
				for (const line of editor.render(width)) {
					expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
				}
			}
		});

		it("does not emit a lone surrogate when the budget splits an astral pair", () => {
			// The box must leave an ODD number of columns for the placeholder, since
			// an even budget divides cleanly into 2-column graphemes and hides the
			// split. available = width - prefix(2) - cursor cell(1), so an even
			// width gives an odd budget.
			const editor = makeEditor({ placeholder: "🚀".repeat(40) });
			for (const width of [32, 50, 60]) {
				// Iterating a string yields whole code points, so an intact pair
				// arrives as a two-unit string. Only a one-unit yield in the
				// surrogate range is an actual orphan.
				for (const codePoint of editor.render(width)[1]) {
					if (codePoint.length !== 1) continue;
					const code = codePoint.charCodeAt(0);
					expect(code >= 0xd800 && code <= 0xdfff, `lone surrogate at width ${width}`).toBe(false);
				}
			}
		});
	});
});

describe("autocomplete chrome", () => {
	/** Two commands, so the dropdown has rows to bracket. */
	const provider = {
		triggerCharacters: ["/"],
		async getSuggestions(lines: string[], _l: number, _c: number) {
			if (!lines[0]?.startsWith("/")) return null;
			return {
				items: [
					{ value: "/model", label: "/model", description: "switch the active model" },
					{ value: "/mode", label: "/mode", description: "change permission mode" },
				],
				prefix: lines[0],
			};
		},
		applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return { lines, cursorLine, cursorCol };
		},
	};

	async function openDropdown(editor: ReturnType<typeof makeEditor>) {
		editor.setAutocompleteProvider(provider as never);
		for (const key of "/mo") editor.handleInput(key);
		// getSuggestions is async; let its promise settle before rendering.
		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	it("adds no rule or footer while the dropdown is closed", () => {
		const output = makeEditor({ autocomplete: true }).render(80).map(plain).join("\n");
		expect(output).not.toContain("┄");
		expect(output).not.toContain("tab complete");
	});

	it("brackets the dropdown rows with a rule above and a footer below", async () => {
		const editor = makeEditor({ autocomplete: true });
		await openDropdown(editor);
		const lines = editor.render(80).map(plain);

		const ruleRow = lines.findIndex((line) => line.includes("┄"));
		const firstItem = lines.findIndex((line) => line.includes("/model"));
		const footerRow = lines.findIndex((line) => line.includes("tab complete"));

		expect(ruleRow, "no rule rendered").toBeGreaterThan(-1);
		expect(firstItem, "no dropdown rows rendered").toBeGreaterThan(ruleRow);
		expect(footerRow, "no footer rendered").toBeGreaterThan(firstItem);
		expect(footerRow).toBe(lines.length - 1);
	});

	it("keeps every line inside the width with the dropdown open", async () => {
		for (const width of [120, 80, 40, 24]) {
			const editor = makeEditor({ autocomplete: true });
			await openDropdown(editor);
			for (const line of editor.render(width)) {
				expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
			}
		}
	});
});
