import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	detectTerminalBackgroundFromEnv,
	getAvailableThemes,
	getDefaultTheme,
	getSelectListTheme,
	initTheme,
	paintBackground,
	theme,
} from "../src/modes/interactive/theme/theme.ts";

const themeDir = join(import.meta.dirname, "../src/modes/interactive/theme");
const schema = JSON.parse(readFileSync(join(themeDir, "theme-schema.json"), "utf-8"));
const apex = JSON.parse(readFileSync(join(themeDir, "apex.json"), "utf-8"));

const requiredColors: string[] = schema.properties.colors.required;
const allowedColors = new Set<string>(Object.keys(schema.properties.colors.properties));

describe("apex theme", () => {
	it("is registered as a built-in alongside dark and light", () => {
		expect(getAvailableThemes()).toEqual(expect.arrayContaining(["apex", "dark", "light"]));
	});

	it("is the default on dark terminals", () => {
		// getDefaultTheme keys off the detected terminal background; on a light
		// terminal it must stay on `light`, since there is no light brand palette.
		const expected = detectTerminalBackgroundFromEnv().theme === "light" ? "light" : "apex";
		expect(getDefaultTheme()).toBe(expected);
	});

	it("defines every colour the schema requires and nothing it forbids", () => {
		for (const key of requiredColors) {
			expect(apex.colors, `missing required colour: ${key}`).toHaveProperty(key);
		}
		for (const key of Object.keys(apex.colors)) {
			expect(allowedColors.has(key), `unknown colour key: ${key}`).toBe(true);
		}
	});

	it("resolves every colour to a concrete value, with no dangling var reference", () => {
		// The theme splits its keys into foreground and background maps; asking for
		// a background key via fg() throws, so route each through its own accessor.
		const backgroundKeys = new Set([
			"selectedBg",
			"scrollbarThumb",
			"userMessageBg",
			"customMessageBg",
			"toolPendingBg",
			"toolSuccessBg",
			"toolErrorBg",
		]);
		initTheme("apex", false);
		for (const key of Object.keys(apex.colors)) {
			const rendered = backgroundKeys.has(key) ? theme.bg(key as never, "sample") : theme.fg(key as never, "sample");
			// A resolved colour emits an SGR sequence around the text; an unresolved
			// var reference would leak the var name or drop the styling entirely.
			expect(rendered, `colour did not resolve: ${key}`).toContain("sample");
			expect(rendered, `colour emitted no styling: ${key}`).not.toBe("sample");
		}
	});

	it("routes chrome through the brand primary", () => {
		// Ember is the Apex identity colour. Operational warning/error colours
		// remain separate so state is never confused with branding.
		expect(apex.colors.accent).toBe("ember");
		expect(apex.colors.border).toBe("ember");
		expect(apex.colors.borderAccent).toBe("ember");
	});

	it("uses the approved Ember neutral and accent system", () => {
		expect(apex.vars).toMatchObject({
			void: "#09090a",
			surface: "#111113",
			panel: "#17171a",
			sel: "#202024",
			line: "#26262b",
			dim: "#5f5f68",
			muted: "#8e8e97",
			text: "#e9e9ec",
			ember: "#c87a46",
			emberSoft: "#e0a479",
			emberDeep: "#7d4726",
			sage: "#7fa37a",
			brick: "#c97070",
			amber: "#c6a052",
			slate: "#6f92a6",
		});
		expect(apex.colors.mdHeading).toBe("emberSoft");
		expect(apex.colors.mdListBullet).toBe("ember");
		expect(apex.colors.thinkingHigh).toBe("emberSoft");
		expect(apex.colors.thinkingXhigh).toBe("ember");
		expect(apex.colors.warning).toBe("amber");
	});

	it("keeps four distinct greys between the ground and the content", () => {
		// The gold palette collapsed rules and labels onto one grey, which is why
		// the metadata column read flat. Each step must be its own value.
		const greys = [apex.vars.line, apex.vars.dim, apex.vars.muted, apex.vars.text];
		expect(new Set(greys).size).toBe(4);
	});

	it("carries no fully saturated hue", () => {
		// The inherited palette shipped #3fb950 and #f85149 for diffs, which
		// vibrate against a near-black ground. Every hue here is desaturated.
		const hexes = Object.values(apex.vars as Record<string, string>).filter((v) => /^#[0-9a-f]{6}$/i.test(v));
		for (const hex of hexes) {
			const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			const saturation = max === 0 ? 0 : (max - min) / max;
			expect(saturation, `${hex} is too saturated`).toBeLessThan(0.75);
		}
	});

	it("keeps every var referenced by colours actually defined", () => {
		const vars = new Set(Object.keys(apex.vars));
		for (const [key, value] of Object.entries(apex.colors) as [string, string][]) {
			if (value.startsWith("#")) continue;
			expect(vars.has(value), `colour ${key} references undefined var: ${value}`).toBe(true);
		}
	});

	it("leaves dark and light loadable so users can switch back", () => {
		for (const name of ["dark", "light"]) {
			initTheme(name, false);
			expect(theme.fg("accent", "x")).toContain("x");
		}
		initTheme("apex", false);
	});
});

describe("overlay chrome", () => {
	it("paints a selected row as a background step, not as accent text", () => {
		// The accent means "Apex owns this". Spending it on every selected row
		// would leave nothing to distinguish the brand from the cursor.
		initTheme("apex", false);
		const selected = getSelectListTheme().selectedText("  /model");
		const selectedBg = theme.bg("selectedBg", "x").replace(`x\u001b[49m`, "");
		expect(selected).toContain(selectedBg);
		expect(selected).toContain("/model");
	});

	it("keeps a background intact across an inner colour reset", () => {
		// A row that already carries foreground colour would otherwise lose its
		// fill at the first reset, leaving the highlight half-painted.
		initTheme("apex", false);
		const row = `${theme.fg("accent", "/model")} plain`;
		const painted = paintBackground(row, "selectedBg");
		const open = theme.bg("selectedBg", "x").replace(`x\u001b[49m`, "");
		expect(painted.split(open).length - 1, "each visible run gets its own fill").toBeGreaterThan(1);
	});
});
