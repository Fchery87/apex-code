import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { ApexSplashHeader } from "../src/modes/interactive/components/splash-header.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { APEX_MARK_BLOCK, APEX_MARK_INLINE, APEX_MARK_INLINE_ASCII } from "../src/themes/apex-logo.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** Strip SGR sequences so assertions can look at the glyphs alone. */
function plain(line: string): string {
	return stripAnsi(line);
}

function render(width: number, options?: Partial<Parameters<typeof makeHeader>[0]>): string[] {
	return makeHeader(options).render(width);
}

function makeHeader(options?: {
	model?: string | undefined;
	cwd?: string;
	symbolPreset?: "unicode" | "ascii";
	verbose?: string;
	inventory?: string;
}) {
	return new ApexSplashHeader(
		"0.0.1-alpha.4",
		() => options?.model ?? "claude-opus-5",
		() => options?.cwd ?? "/tmp/apex-fixture",
		options?.verbose,
		{
			getSymbolPreset: () => options?.symbolPreset ?? "unicode",
			getInventory: () => options?.inventory,
			inventoryHint: "/resources",
			getHint: () => "Apex Code can explain its own features and look up its docs.",
		},
	);
}

const MARK_TOP = (APEX_MARK_BLOCK.rows[0].accent + APEX_MARK_BLOCK.rows[0].text).trim();
const MARK_BASELINE = (APEX_MARK_BLOCK.rows[4].accent + APEX_MARK_BLOCK.rows[4].text).trim();
const INLINE_MARK = (APEX_MARK_INLINE.rows[0].accent + APEX_MARK_INLINE.rows[0].text).trim();
const INLINE_ASCII_MARK = (APEX_MARK_INLINE_ASCII.rows[0].accent + APEX_MARK_INLINE_ASCII.rows[0].text).trim();

describe("ApexSplashHeader", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	describe("width safety", () => {
		// The header renders into a fixed-width dock; a single over-long line
		// corrupts the whole frame, so this holds at every tier and in between.
		for (const width of [120, 100, 80, 70, 57, 56, 50, 41, 38, 30, 20, 10, 1]) {
			it(`emits no line wider than ${width} columns`, () => {
				for (const line of render(width)) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			});
		}

		it("never splits a half-block glyph across the width boundary", () => {
			// Any block glyph that survives truncation must be intact, not a
			// replacement character from a mid-codepoint cut.
			for (const width of [30, 36, 44, 60]) {
				for (const line of render(width)) {
					expect(plain(line)).not.toContain("�");
				}
			}
		});
	});

	describe("degradation tiers", () => {
		it("shows the full mark and the metadata column when there is room", () => {
			const output = render(100).map(plain).join("\n");
			expect(output).toContain(MARK_TOP);
			expect(output).toContain("version");
			expect(output).toContain("v0.0.1-alpha.4");
			expect(output).toContain("claude-opus-5");
			expect(output).toContain("cwd");
		});

		it("drops the metadata column but keeps the full mark at mid widths", () => {
			const output = render(40).map(plain).join("\n");
			expect(output).toContain(MARK_TOP);
			expect(output).not.toContain("version");
			expect(output).not.toContain("claude-opus-5");
		});

		it("replaces the block mark with the type lockup below its width", () => {
			// The block wordmark does not shrink. A two- or three-row block form
			// dissolves into texture on a monospace grid, so the narrow fallback
			// is type instead of a smaller block.
			const output = render(APEX_MARK_BLOCK.width - 1)
				.map(plain)
				.join("\n");
			expect(output).toContain(INLINE_MARK);
			expect(output).not.toContain("█");
		});
	});

	describe("symbol preset", () => {
		it("uses the ASCII mark when the preset is ascii", () => {
			const output = render(100, { symbolPreset: "ascii" }).map(plain).join("\n");
			expect(output).toContain(INLINE_ASCII_MARK);
			expect(output).not.toContain("█");
			expect(output).not.toContain("▄");
			expect(output).not.toContain("▀");
		});

		it("spells the product name in every mark", () => {
			// The previous ASCII mark was line-drawn art whose first letter was an
			// O, so it read OPEX. Type cannot drift that way.
			expect(INLINE_MARK).toContain("apex code");
			expect(INLINE_ASCII_MARK).toContain("apex code");
		});

		it("draws its rule with dashes under the ascii preset", () => {
			const output = render(100, { symbolPreset: "ascii", inventory: "12 skills" }).map(plain).join("\n");
			expect(output).toContain("12 skills");
			expect(output).not.toContain("─");
			expect(output).toContain("-".repeat(20));
		});

		it("still renders the metadata column alongside the ASCII mark", () => {
			const output = render(100, { symbolPreset: "ascii" }).map(plain).join("\n");
			expect(output).toContain("version");
			expect(output).toContain("claude-opus-5");
		});
	});

	describe("live values", () => {
		it("reflects a model that resolves after construction", () => {
			// The session binds after the header is built, so the getter must be
			// read at render time rather than captured in the constructor.
			let model: string | undefined;
			const header = new ApexSplashHeader(
				"0.0.1-alpha.4",
				() => model,
				() => "/tmp/apex-fixture",
				undefined,
				{ getSymbolPreset: () => "unicode" },
			);

			expect(header.render(100).map(plain).join("\n")).toContain("—");

			model = "claude-opus-5";
			expect(header.render(100).map(plain).join("\n")).toContain("claude-opus-5");
		});

		it("renders the hint in full rather than squeezing it into the metadata column", () => {
			// The hint is wider than the right-hand column, so confining it there
			// truncated it even on a wide terminal.
			const hint = "Apex Code can explain its own features and look up its docs.";
			for (const width of [120, 96, 70]) {
				expect(render(width).map(plain).join("\n")).toContain(hint);
			}
		});

		it("keeps the leaf directory visible when the cwd is too long", () => {
			const cwd = `/tmp/${"nested-directory/".repeat(12)}the-actual-project`;
			const output = render(100, { cwd }).map(plain).join("\n");
			expect(output).toContain("the-actual-project");
			expect(output).toContain("…/");
		});

		it("clips an over-long single segment without splitting a character", () => {
			// One path segment wider than the whole value column, made of
			// double-width astral characters. Clipping by UTF-16 offset would emit a
			// lone surrogate; clipping by code unit would also miscount the width.
			const cwd = `/${"🚀".repeat(120)}`;
			for (const width of [100, 81, 80, 60]) {
				for (const line of render(width, { cwd })) {
					expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
					expect(plain(line), `width ${width}`).not.toContain("�");
					// Iterating a string yields whole code points, so an intact pair
					// arrives as a two-unit string. Only a one-unit yield in the
					// surrogate range is an actual orphan.
					for (const codePoint of line) {
						if (codePoint.length !== 1) continue;
						const code = codePoint.charCodeAt(0);
						expect(code >= 0xd800 && code <= 0xdfff, `lone surrogate at width ${width}`).toBe(false);
					}
				}
			}
		});
	});

	describe("accent footing", () => {
		it("paints the baseline row in the accent and the rest in text", () => {
			// The whole logo treatment is one accent row, so the mark sits on an
			// ember footing without competing with the content beside it.
			const lines = render(100);
			const baseline = lines.find((line) => plain(line).includes(MARK_BASELINE));
			const upper = lines.find((line) => plain(line).includes(MARK_TOP));
			expect(baseline, "baseline row missing").toBeDefined();
			expect(upper, "top row missing").toBeDefined();
			expect(baseline).not.toBe(upper);
			// Different tones mean different SGR prefixes on the two rows.
			const sgr = (line: string) => line.match(/\x1b\[[0-9;]*m/)?.[0];
			expect(sgr(baseline as string)).not.toBe(sgr(upper as string));
		});
	});

	describe("inventory band", () => {
		it("renders the counted line between two rules", () => {
			const lines = render(100, { inventory: "152 skills · 8 extensions" }).map(plain);
			const row = lines.findIndex((line) => line.includes("152 skills"));
			expect(row).toBeGreaterThan(0);
			expect(lines[row - 1]).toContain("─");
			expect(lines[row + 1]).toContain("─");
		});

		it("omits the band entirely when there is nothing to count", () => {
			expect(render(100).map(plain).join("\n")).not.toContain("─");
		});

		it("drops the band rather than clipping it on a narrow terminal", () => {
			expect(render(10, { inventory: "152 skills" }).map(plain).join("\n")).not.toContain("─");
		});

		it("drops the hint whole rather than clipping it to a stub", () => {
			// A clipped affordance renders as a bare "/" and names no command.
			const wide = render(80, { inventory: "115 skills · 1 conflict" }).map(plain).join("\n");
			expect(wide).toContain("/resources");

			const narrow = render(28, { inventory: "115 skills · 1 conflict" }).map(plain).join("\n");
			expect(narrow).toContain("115 skills");
			expect(narrow).not.toContain("/resources");
			expect(narrow).not.toMatch(/\/r?e?s?$/m);
		});

		it("keeps every line inside the width with the band present", () => {
			for (const width of [120, 80, 57, 40, 30, 20, 12, 11, 5, 1]) {
				for (const line of render(width, { inventory: "152 skills · 8 extensions · 1 conflict" })) {
					expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
				}
			}
		});
	});

	describe("metadata beside a one-row mark", () => {
		it("shows every metadata row even when the mark is a single line", () => {
			// The ascii preset picks a one-row lockup. Iterating mark rows alone
			// would drop the second and third metadata rows on the floor.
			const output = render(100, { symbolPreset: "ascii" }).map(plain).join("\n");
			expect(output).toContain("version");
			expect(output).toContain("model");
			expect(output).toContain("cwd");
		});
	});

	describe("verbose instructions", () => {
		it("omits the cheatsheet by default", () => {
			expect(render(100).map(plain).join("\n")).not.toContain("to interrupt");
		});

		it("renders the cheatsheet under the mark when verbose", () => {
			const output = render(100, { verbose: "ctrl+c to interrupt\nctrl+d to exit" }).map(plain).join("\n");
			expect(output).toContain("to interrupt");
			expect(output).toContain("to exit");
			// It sits below the mark, not beside it.
			const lines = output.split("\n");
			const markRow = lines.findIndex((line) => line.includes(MARK_TOP));
			const hintRow = lines.findIndex((line) => line.includes("to interrupt"));
			expect(hintRow).toBeGreaterThan(markRow);
		});
	});
});
