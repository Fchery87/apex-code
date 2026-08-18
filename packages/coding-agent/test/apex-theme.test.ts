import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	detectTerminalBackgroundFromEnv,
	getAvailableThemes,
	getDefaultTheme,
	initTheme,
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
		// The point of the palette is that accent and borders share one hue,
		// rather than the unrelated accent/blue/cyan split it replaces.
		expect(apex.colors.accent).toBe("primary");
		expect(apex.colors.border).toBe("primary");
		expect(apex.colors.borderAccent).toBe("primary");
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
