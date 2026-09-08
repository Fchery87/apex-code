import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const SENTINEL = "\u0000";

/**
 * The opening escape a theme paint emits, isolated from its closing one.
 *
 * Rendered rows carry colour, so an assertion on stripped text cannot tell a
 * background step from accent-coloured text. An assertion on the opening
 * sequence can, and it stays correct when the palette retunes.
 */
export function openSequence(paint: (text: string) => string): string {
	return paint(SENTINEL).split(SENTINEL)[0] ?? "";
}

function closeSequence(paint: (text: string) => string): string {
	return paint(SENTINEL).split(SENTINEL)[1] ?? "";
}

/** The selected-row background every list is meant to share. */
export const selectedRowOpen = (): string => openSequence((text) => theme.bg("selectedBg", text));

/** Accent foreground, which a selected row must no longer use to carry selection. */
export const accentOpen = (): string => openSequence((text) => theme.fg("accent", text));

/**
 * Visible characters that actually carry the selected-row background.
 *
 * A rendered row is padded to the render width by its Text component, so the
 * line's own length says nothing about how far the fill reaches. This reads the
 * painted runs instead, which is the thing under test. `paintBackground` emits
 * one run per visible stretch, so the runs are summed.
 */
export function paintedWidth(line: string): number {
	const open = selectedRowOpen();
	const close = closeSequence((text) => theme.bg("selectedBg", text));
	let width = 0;
	let rest = line;
	while (rest.includes(open)) {
		const after = rest.slice(rest.indexOf(open) + open.length);
		const end = after.indexOf(close);
		if (end === -1) break;
		width += stripAnsi(after.slice(0, end)).length;
		rest = after.slice(end + close.length);
	}
	return width;
}
