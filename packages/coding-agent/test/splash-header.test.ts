import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { ApexSplashHeader } from "../src/modes/interactive/components/splash-header.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { APEX_PEAK_LOGO, APEX_PEAK_LOGO_ASCII, APEX_PEAK_LOGO_COMPACT } from "../src/themes/apex-logo.ts";
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
}) {
	return new ApexSplashHeader(
		"0.0.1-alpha.4",
		() => options?.model ?? "claude-opus-5",
		() => options?.cwd ?? "/tmp/apex-fixture",
		options?.verbose,
		{
			getSymbolPreset: () => options?.symbolPreset ?? "unicode",
			getHint: () => "Apex Code can explain its own features and look up its docs.",
		},
	);
}

const LOGO_WIDTH = APEX_PEAK_LOGO.split("\n").reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
const COMPACT_WIDTH = APEX_PEAK_LOGO_COMPACT.split("\n").reduce((max, line) => Math.max(max, visibleWidth(line)), 0);

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
			expect(output).toContain(APEX_PEAK_LOGO.split("\n")[0].trim());
			expect(output).toContain("version");
			expect(output).toContain("v0.0.1-alpha.4");
			expect(output).toContain("claude-opus-5");
			expect(output).toContain("cwd");
		});

		it("drops the metadata column but keeps the full mark at mid widths", () => {
			const output = render(50).map(plain).join("\n");
			expect(output).toContain(APEX_PEAK_LOGO.split("\n")[0].trim());
			expect(output).not.toContain("version");
			expect(output).not.toContain("claude-opus-5");
		});

		it("falls back to the compact mark below the full mark's width", () => {
			const output = render(COMPACT_WIDTH + 6)
				.map(plain)
				.join("\n");
			expect(output).toContain(APEX_PEAK_LOGO_COMPACT.split("\n")[0].trim());
			// The full mark's widest row cannot fit here.
			expect(visibleWidth(output.split("\n")[1] ?? "")).toBeLessThan(LOGO_WIDTH);
		});
	});

	describe("symbol preset", () => {
		it("uses the ASCII mark when the preset is ascii", () => {
			const output = render(100, { symbolPreset: "ascii" }).map(plain).join("\n");
			expect(output).toContain(APEX_PEAK_LOGO_ASCII.split("\n")[0].trim());
			expect(output).not.toContain("█");
			expect(output).not.toContain("▄");
			expect(output).not.toContain("▀");
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
			const markRow = lines.findIndex((line) => line.includes(APEX_PEAK_LOGO.split("\n")[0].trim()));
			const hintRow = lines.findIndex((line) => line.includes("to interrupt"));
			expect(hintRow).toBeGreaterThan(markRow);
		});
	});
});
