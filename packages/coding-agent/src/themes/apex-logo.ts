import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * The Apex Code brand mark, in the forms a terminal can actually render.
 *
 * Only the five-row block wordmark survives a monospace grid. Every monospace
 * face leaves a hairline gap at the cell boundary, so a letterform two or three
 * rows tall dissolves into texture rather than reading as a word. The mark
 * therefore does not shrink: below the width the block form needs, it is
 * replaced outright by a glyph-and-type lockup.
 *
 * A mark is a list of rows, each split into an accent run and a text run. That
 * one shape covers both forms: the block wordmark puts its whole baseline row
 * in the accent so the letters sit on an ember footing, and the inline lockup
 * puts only its leading glyph there.
 */

export interface MarkRow {
	/** Leading run, painted in the brand accent. */
	readonly accent: string;
	/** Trailing run, painted in the neutral text tone. */
	readonly text: string;
}

export interface BrandMark {
	readonly rows: readonly MarkRow[];
	/** Widest row, in terminal columns. */
	readonly width: number;
}

export type MarkSymbolPreset = "unicode" | "ascii";

function mark(rows: readonly MarkRow[]): BrandMark {
	return {
		rows,
		width: rows.reduce((max, row) => Math.max(max, visibleWidth(row.accent + row.text)), 0),
	};
}

const BLOCK_ROWS = [
	" ▄▄▄▄▄  ▄▄▄▄▄▄  ▄▄▄▄▄▄ ▄▄   ▄▄",
	"██   ██ ██   ██ ██      ██ ██ ",
	"███████ ██████  █████    ███  ",
	"██   ██ ██      ██      ██ ██ ",
	"▀▀   ▀▀ ▀▀      ▀▀▀▀▀▀ ▀▀   ▀▀",
];

/** 5 rows x 30 columns. The brand mark, with the baseline row in the accent. */
export const APEX_MARK_BLOCK = mark(
	BLOCK_ROWS.map((row, index) =>
		index === BLOCK_ROWS.length - 1 ? { accent: row, text: "" } : { accent: "", text: row },
	),
);

/** 1 row x 11 columns. Used when the block mark will not fit. */
export const APEX_MARK_INLINE = mark([{ accent: "◤", text: " apex code" }]);

/**
 * 1 row x 12 columns. Honours `terminal.symbolPreset: "ascii"`, whose users
 * opted out of block drawing because it renders badly for them. The previous
 * ASCII mark was line-drawn art whose first letter was an O, so it read "OPEX".
 */
export const APEX_MARK_INLINE_ASCII = mark([{ accent: "/\\", text: " apex code" }]);

/** Pick the widest mark that fits. ASCII users always get the type lockup. */
export function selectBrandMark(contentWidth: number, symbolPreset: MarkSymbolPreset): BrandMark {
	if (symbolPreset === "ascii") return APEX_MARK_INLINE_ASCII;
	return contentWidth >= APEX_MARK_BLOCK.width ? APEX_MARK_BLOCK : APEX_MARK_INLINE;
}

/** Wrap a mark supplied by a rebranding extension. It carries no accent run. */
export function customBrandMark(logo: string): BrandMark {
	return mark(logo.split("\n").map((row) => ({ accent: "", text: row })));
}
