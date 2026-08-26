import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type BrandMark,
	customBrandMark,
	type MarkRow,
	type MarkSymbolPreset,
	selectBrandMark,
} from "../../../themes/apex-logo.ts";
import { theme } from "../theme/theme.ts";
import { formatCwdForFooter } from "./footer.ts";

/** One `label  value` row in the metadata column. */
export interface SplashHeaderMetadataLine {
	label: string;
	value: string;
}

export interface ApexSplashHeaderOptions {
	/** Rows appended after `cwd`, for extensions that want to contribute context. */
	getExtraMetadata?: () => readonly SplashHeaderMetadataLine[];
	/**
	 * One line of counted totals, rendered between the rules under the mark.
	 * The header does not know how to count anything; the caller supplies the
	 * finished line so the resource loader stays on its own side of the seam.
	 */
	getInventory?: () => string | undefined;
	/**
	 * Affordance appended to the inventory line, e.g. the command that shows the
	 * detail. Dropped whole rather than clipped, so it never renders as a stub.
	 */
	inventoryHint?: string;
	/** Hint rendered under the metadata block. Return undefined for none. */
	getHint?: () => string | undefined;
	/**
	 * One row of entry-point sigils under the hint, already coloured by the
	 * caller. The header does not know the keybindings, so it does not build it.
	 */
	getShortcuts?: () => string | undefined;
	/** Resolves `terminal.symbolPreset`. Defaults to unicode. */
	getSymbolPreset?: () => MarkSymbolPreset;
	/** Emit a leading blank line above the mark. */
	topPadding?: boolean;
	/** Override the mark. Used by tests and by extensions that rebrand. */
	logo?: string;
}

/**
 * Paint one mark row: accent run then text run.
 *
 * Empty runs are skipped so no row carries a bare, unclosed SGR pair.
 */
export function paintMarkRow(row: MarkRow): string {
	const accent = row.accent ? theme.fg("accent", row.accent) : "";
	const text = row.text ? theme.fg("text", row.text) : "";
	return accent + text;
}

/** The whole mark as painted lines, for surfaces that just want to stamp it. */
export function paintBrandMark(brandMark: BrandMark): string[] {
	return brandMark.rows.map(paintMarkRow);
}

const GUTTER = 4;
const LABEL_WIDTH = 9;
/** Smallest value column worth rendering; below this the metadata column is dropped. */
const MIN_VALUE_WIDTH = 8;
/** Below this the rules and the inventory line are dropped rather than clipped. */
const MIN_RULE_WIDTH = 12;

/**
 * Keep the rightmost path segments that fit, so the leaf directory stays visible.
 *
 * `truncateToWidth` clips the tail, which for a path hides the part that
 * identifies the session. This clips the head instead.
 */
function truncatePathTail(path: string, maxWidth: number): string {
	if (maxWidth <= 0) {
		return "";
	}
	if (visibleWidth(path) <= maxWidth) {
		return path;
	}
	const ellipsis = "…/";
	const budget = Math.max(0, maxWidth - visibleWidth(ellipsis));
	const segments = path.split("/");
	let tail = "";
	for (let index = segments.length - 1; index >= 0; index--) {
		const candidate = tail ? `${segments[index]}/${tail}` : segments[index];
		if (visibleWidth(candidate) > budget) {
			break;
		}
		tail = candidate;
	}
	// A single segment longer than the whole budget: clip it from the left.
	return tail ? ellipsis + tail : ellipsis + trailingByWidth(path, budget);
}

/**
 * The widest suffix of `text` that fits `maxWidth` terminal columns.
 *
 * Walks grapheme clusters from the right rather than using `String.slice`, whose
 * UTF-16 offsets would cut an astral character in half — emitting a lone
 * surrogate — and would miscount every double-width character on the way.
 */
function trailingByWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) {
		return "";
	}
	const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
		(entry) => entry.segment,
	);
	let width = 0;
	let index = graphemes.length;
	while (index > 0) {
		const next = width + visibleWidth(graphemes[index - 1]);
		if (next > maxWidth) {
			break;
		}
		width = next;
		index -= 1;
	}
	return graphemes.slice(index).join("");
}

/**
 * Startup header: brand mark on the left, runtime metadata on the right, then a
 * ruled band carrying the counted inventory.
 *
 * Values are read through getters rather than captured at construction, so the
 * model fills in once the session binds without an explicit refresh.
 *
 * The metadata column is dropped when the terminal cannot hold it, and the mark
 * falls back to a type lockup rather than being truncated mid-glyph.
 */
export class ApexSplashHeader implements Component {
	private readonly version: string;
	private readonly getModelId: () => string | undefined;
	private readonly getCwd: () => string;
	private readonly verboseInstructions: string | undefined;
	private readonly options: ApexSplashHeaderOptions;

	constructor(
		version: string,
		getModelId: () => string | undefined,
		getCwd: () => string,
		verboseInstructions?: string,
		options: ApexSplashHeaderOptions = {},
	) {
		this.version = version;
		this.getModelId = getModelId;
		this.getCwd = getCwd;
		this.verboseInstructions = verboseInstructions;
		this.options = options;
	}

	invalidate(): void {
		// Render output is derived from current theme and session state.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const paddingX = safeWidth > 1 ? 1 : 0;
		const contentWidth = Math.max(1, safeWidth - paddingX * 2);
		const symbolPreset = this.options.getSymbolPreset?.() ?? "unicode";

		const brandMark = this.options.logo
			? customBrandMark(this.options.logo)
			: selectBrandMark(contentWidth, symbolPreset);

		const metaWidth = contentWidth - brandMark.width - GUTTER;
		const showMeta = metaWidth >= LABEL_WIDTH + MIN_VALUE_WIDTH;
		const valueWidth = Math.max(1, metaWidth - LABEL_WIDTH);
		const metaLines = showMeta ? this.buildMetadata(valueWidth) : [];
		// Bottom-aligned, so the last metadata row sits on the mark's ember
		// baseline and the two read as one block rather than two stacks.
		const metaStart = Math.max(0, brandMark.rows.length - metaLines.length);

		const lines = this.options.topPadding ? [this.padLine("", safeWidth, paddingX)] : [];

		// The mark and the metadata column are two stacks of different heights
		// sharing one block, so the block is as tall as the taller of them. A
		// one-row mark beside three metadata rows still shows all three.
		const blockRows = Math.max(brandMark.rows.length, metaStart + metaLines.length);
		for (let index = 0; index < blockRows; index++) {
			const row = brandMark.rows[index];
			const painted = row ? paintMarkRow(row) : "";
			const rowWidth = row ? visibleWidth(row.accent + row.text) : 0;
			const meta = index >= metaStart ? (metaLines[index - metaStart] ?? "") : "";
			const gap = showMeta ? " ".repeat(Math.max(0, brandMark.width - rowWidth + GUTTER)) : "";
			const content = truncateToWidth(painted + (meta ? gap + meta : ""), contentWidth, "");
			lines.push(this.padLine(content, safeWidth, paddingX));
		}

		// Counted totals sit in a ruled band of their own. The rules are what
		// carry the structure on this screen, so nothing here is boxed.
		const inventory = this.options.getInventory?.();
		if (inventory && contentWidth >= MIN_RULE_WIDTH) {
			const rule = theme.fg("borderMuted", (symbolPreset === "ascii" ? "-" : "─").repeat(contentWidth));
			lines.push(this.padLine("", safeWidth, paddingX));
			lines.push(this.padLine(rule, safeWidth, paddingX));
			const hint = this.options.inventoryHint;
			const withHint = hint ? `${inventory}  ${theme.fg("dim", hint)}` : inventory;
			const fitted =
				visibleWidth(withHint) <= contentWidth ? withHint : truncateToWidth(inventory, contentWidth, "");
			lines.push(this.padLine(fitted, safeWidth, paddingX));
			lines.push(this.padLine(rule, safeWidth, paddingX));
		}

		// The hint is product copy rather than a runtime fact, so it sits under the
		// whole block at full width instead of inside the narrow metadata column,
		// where it would truncate even on a wide terminal.
		const hint = this.options.getHint?.();
		if (hint) {
			lines.push(this.padLine("", safeWidth, paddingX));
			lines.push(this.padLine(theme.fg("dim", truncateToWidth(hint, contentWidth)), safeWidth, paddingX));
		}

		const shortcuts = this.options.getShortcuts?.();
		if (shortcuts) {
			lines.push(this.padLine("", safeWidth, paddingX));
			lines.push(this.padLine(truncateToWidth(shortcuts, contentWidth, ""), safeWidth, paddingX));
		}

		if (this.verboseInstructions) {
			lines.push(this.padLine("", safeWidth, paddingX));
			for (const instruction of this.verboseInstructions.split("\n")) {
				lines.push(this.padLine(truncateToWidth(instruction, contentWidth), safeWidth, paddingX));
			}
		}

		return lines;
	}

	private buildMetadata(valueWidth: number): string[] {
		const labelled = (label: string, value: string) =>
			theme.fg("dim", label.padEnd(LABEL_WIDTH)) + theme.fg("muted", truncateToWidth(value, valueWidth));

		const cwd = formatCwdForFooter(this.getCwd(), process.env.HOME || process.env.USERPROFILE);
		return [
			labelled("version", `v${this.version}`),
			labelled("model", this.getModelId() ?? "—"),
			theme.fg("dim", "cwd".padEnd(LABEL_WIDTH)) + theme.fg("muted", truncatePathTail(cwd, valueWidth)),
			...(this.options.getExtraMetadata?.() ?? []).map((line) => labelled(line.label, line.value)),
		];
	}

	private padLine(content: string, safeWidth: number, paddingX: number): string {
		const trailing = Math.max(0, safeWidth - paddingX - visibleWidth(content));
		return " ".repeat(paddingX) + content + " ".repeat(trailing);
	}
}
