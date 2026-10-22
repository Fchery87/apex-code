import { theme } from "../theme/theme.ts";

export type UiSymbolPreset = "unicode" | "ascii";

/**
 * The glyphs the interactive UI draws, one pair per preset.
 *
 * Every entry is two columns, the width the rows already budget for a cursor.
 * A component that draws its own `→` or `✓` bypasses `terminal.symbolPreset`,
 * so the selectors read these instead.
 */
const GLYPHS = {
	unicode: { cursor: "→ ", prompt: "› ", check: "✓ ", bullet: "• ", left: "← ", right: "→ " },
	ascii: { cursor: "> ", prompt: "> ", check: "* ", bullet: "- ", left: "< ", right: "> " },
} as const;

export type UiGlyph = keyof (typeof GLYPHS)["unicode"];

let activePreset: UiSymbolPreset = "unicode";

/** The preset the selectors and the composer read. Defaults to unicode. */
export function getUiSymbolPreset(): UiSymbolPreset {
	return activePreset;
}

export function setUiSymbolPreset(preset: UiSymbolPreset): void {
	activePreset = preset;
}

export function uiGlyph(name: UiGlyph, preset: UiSymbolPreset = activePreset): string {
	return GLYPHS[preset][name];
}

/** A selected row's cursor, already painted. Two columns either way. */
export function selectionCursor(selected: boolean, preset?: UiSymbolPreset): string {
	return selected ? theme.fg("accent", uiGlyph("cursor", preset)) : "  ";
}

/** The mark beside the option that is already saved. Two columns either way. */
export function savedMark(saved: boolean, preset?: UiSymbolPreset): string {
	return saved ? theme.fg("success", uiGlyph("check", preset)) : "  ";
}
