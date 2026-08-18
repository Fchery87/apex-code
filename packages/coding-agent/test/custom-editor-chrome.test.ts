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

function makeEditor(options?: { placeholder?: string; promptPrefix?: string; focused?: boolean; paddingX?: number }) {
	const tui = { terminal: { rows: 40, cols: 80 }, requestRender() {}, invalidate() {} };
	const editor = new CustomEditor(tui as never, getEditorTheme(), new KeybindingsManager(), {
		paddingX: options?.paddingX ?? 0,
		promptPrefix: options?.promptPrefix ?? "> ",
		promptColor: (text) => theme.fg("accent", text),
		placeholder: options?.placeholder ?? PLACEHOLDER,
		placeholderColor: (text) => theme.fg("dim", text),
	});
	editor.focused = options?.focused ?? true;
	return editor;
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

	describe("prompt prefix", () => {
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
});
