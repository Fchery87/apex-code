/**
 * Row rendering for the model step of the model picker.
 *
 * The effort-cluster placement and the price panel are adapted from Prime Agent
 * (https://github.com/PrimeIntellect-ai/prime-agent), a separate Pi-derived fork
 * under the MIT License. ADR 0002 permits that for MIT prior art; NOTICE records
 * the attribution. Apex Code's own panel chrome, cursor, and theme tokens are
 * kept, so this is the row and nothing above it.
 */

import type { ModelCost, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.ts";

/** Columns the cursor cell occupies at the head of every row. */
const CURSOR_WIDTH = 2;
const NAME_COLUMN_MAX = 30;
const NAME_COLUMN_MIN = 12;
/** `← ` + squares + ` → ` around the cluster, plus at least one column of gap before it. */
const CLUSTER_CHROME = 5;
const CLUSTER_CHROME_AND_GAP = CLUSTER_CHROME + 1;
const PRICE_UNIT_TEXT = "$ / 1M tokens";
/** A wide price column must still fit the longest label, "Cached input". */
const PRICE_COLUMN_MIN_WIDTH = 13;
/**
 * Past this the three prices stop reading as one group and become three lonely
 * numbers spread across the terminal, so the block stays put and the row ends early.
 */
const PRICE_COLUMN_MAX_WIDTH = 18;
const PRICE_WIDE_LAYOUT_MIN_WIDTH = 58;

const THINKING_COLORS: Record<ModelThinkingLevel, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/**
 * Column budget the effort cluster gets on every row of one rendered page.
 *
 * It is computed once per page rather than per row so the squares sit in the
 * same column all the way down. A per-row measurement would shift the cluster
 * whenever a neighbouring name or level label changed length, which reads as
 * the list wobbling while you arrow through it.
 */
export interface EffortLayout {
	nameColumn: number;
	squareSlots: number;
	gap: number;
	labelWidth: number;
	showLabel: boolean;
	showCluster: boolean;
}

export const NO_EFFORT_CLUSTER: EffortLayout = {
	nameColumn: 0,
	squareSlots: 0,
	gap: 0,
	labelWidth: 0,
	showLabel: false,
	showCluster: false,
};

/** One visible row's inputs to the page-wide layout measurement. */
export interface EffortLayoutRow {
	name: string;
	/** Selectable thinking levels, empty when the model has no reasoning to dial. */
	levels: ReadonlyArray<ModelThinkingLevel>;
	trailingSegments: ReadonlyArray<string>;
}

/**
 * Drop trailing segments from the front until the cluster fits its budget.
 *
 * The last segment is the one that identifies the row, so it is the one that
 * survives; the provider badge and status words in front of it are context.
 */
function reduceTrailingSegments(segments: ReadonlyArray<string>, budget: number): string[] {
	let current = segments.filter((segment) => visibleWidth(segment) > 0);
	while (current.length > 1 && visibleWidth(current.join(" · ")) > budget) {
		current = current.slice(1);
	}
	return current;
}

function trailingBudget(width: number): number {
	return Math.max(1, width - CURSOR_WIDTH - 5);
}

/** Rendered width of a trailing cluster, degraded and truncated exactly as {@link renderTrailing} will. */
export function getTrailingWidth(segments: ReadonlyArray<string>, width: number): number {
	const budget = trailingBudget(width);
	const reduced = reduceTrailingSegments(segments, budget);
	if (reduced.length === 0) return 0;
	return Math.min(visibleWidth(reduced.join(" · ")), budget);
}

function renderTrailing(segments: ReadonlyArray<string>, width: number): string {
	const budget = trailingBudget(width);
	const reduced = reduceTrailingSegments(segments, budget);
	if (reduced.length === 0) return "";
	return truncateToWidth(reduced.join(theme.fg("borderMuted", " · ")), budget, "…");
}

/**
 * Where the effort cluster sits on this page, or {@link NO_EFFORT_CLUSTER} when it does not fit.
 *
 * The cluster is placed near the row's horizontal centre and then given up one
 * piece at a time as the terminal narrows: first the centring gap, then the
 * name column, then the level label, then the cluster itself. Rows stay aligned
 * at every width because each step is taken for the whole page at once.
 */
export function getEffortLayout(rows: ReadonlyArray<EffortLayoutRow>, width: number): EffortLayout {
	const reasoningRows = rows.filter((row) => row.levels.length > 0);
	if (reasoningRows.length === 0) return NO_EFFORT_CLUSTER;

	const maxTrailingWidth = Math.max(0, ...rows.map((row) => getTrailingWidth(row.trailingSegments, width)));
	const available = Math.max(1, width - CURSOR_WIDTH - maxTrailingWidth - 2);

	const maxNameColumn = Math.min(Math.max(...reasoningRows.map((row) => visibleWidth(row.name))), NAME_COLUMN_MAX);
	const squareSlots = Math.max(...reasoningRows.map((row) => row.levels.filter((level) => level !== "off").length));
	// A fixed label cell sized to the longest level name, so dialling effort up
	// and down never changes the cluster's span or its centred gap.
	const labelWidth = Math.max(...reasoningRows.flatMap((row) => row.levels.map((level) => visibleWidth(level))));

	const place = (nameColumn: number, showLabel: boolean): EffortLayout => {
		const span = squareSlots + (showLabel ? labelWidth + CLUSTER_CHROME : CLUSTER_CHROME - 1);
		const desired = Math.floor(width / 2 - span / 2) - CURSOR_WIDTH - nameColumn;
		const gap = Math.max(1, Math.min(desired, available - nameColumn - span));
		return { nameColumn, squareSlots, gap, labelWidth, showLabel, showCluster: true };
	};

	if (maxNameColumn + squareSlots + labelWidth + CLUSTER_CHROME_AND_GAP <= available) {
		return place(maxNameColumn, true);
	}
	const labelNameColumn = available - squareSlots - labelWidth - CLUSTER_CHROME_AND_GAP;
	if (labelNameColumn >= NAME_COLUMN_MIN) {
		return place(Math.min(maxNameColumn, labelNameColumn), true);
	}
	if (maxNameColumn + squareSlots + CLUSTER_CHROME_AND_GAP <= available) {
		return place(maxNameColumn, false);
	}
	const clusterNameColumn = available - squareSlots - CLUSTER_CHROME_AND_GAP;
	if (clusterNameColumn >= NAME_COLUMN_MIN) {
		return place(Math.min(maxNameColumn, clusterNameColumn), false);
	}
	return NO_EFFORT_CLUSTER;
}

function renderEffortSquares(
	levels: ReadonlyArray<ModelThinkingLevel>,
	effort: ModelThinkingLevel,
	squareSlots: number,
	selected: boolean,
): string {
	const onLevels = levels.filter((level) => level !== "off");
	if (onLevels.length === 0) return "";
	const filledCount = effort === "off" ? 0 : onLevels.indexOf(effort) + 1;
	// Only the highlighted row's squares carry the level's colour. Colouring
	// every row turned the list into a stripe of unrelated hues.
	const paintFilled = (glyph: string) =>
		selected ? theme.fg(THINKING_COLORS[effort], glyph) : theme.fg("muted", glyph);
	const marks = onLevels.map((_, index) => (index < filledCount ? paintFilled("■") : theme.fg("dim", "□"))).join("");
	return marks + " ".repeat(Math.max(0, squareSlots - visibleWidth(marks)));
}

export interface ModelRowOptions {
	name: string;
	levels: ReadonlyArray<ModelThinkingLevel>;
	effort: ModelThinkingLevel | undefined;
	trailingSegments: ReadonlyArray<string>;
	selected: boolean;
	layout: EffortLayout;
	width: number;
}

/**
 * One model row: cursor, name, optional effort cluster, right-aligned trailing context.
 *
 * The line is padded out to `width` so the caller's selection fill covers the
 * whole row rather than stopping at the last glyph.
 */
export function composeModelRow(options: ModelRowOptions): string {
	const { name, levels, effort, trailingSegments, selected, layout, width } = options;
	// Selection is carried by the background step alone, so the cursor stays
	// uncoloured: the accent means "Apex owns this" everywhere else on screen.
	const cursor = selected ? "→ " : "  ";
	const inner = Math.max(1, width - CURSOR_WIDTH);
	const trailing = renderTrailing(trailingSegments, width);
	const trailingWidth = visibleWidth(trailing);

	let primary: string;
	if (layout.showCluster && levels.length > 0 && effort !== undefined) {
		const nameCell = truncateToWidth(name, layout.nameColumn, "…", true);
		const gap = " ".repeat(layout.gap);
		// The arrows are the affordance for left/right, so they appear only on the
		// row they would act on. Their columns are reserved on every row regardless.
		const leftArrow = selected ? theme.fg("dim", "←") : " ";
		const rightArrow = selected ? theme.fg("dim", "→") : " ";
		const squares = renderEffortSquares(levels, effort, layout.squareSlots, selected);
		const label = layout.showLabel ? ` ${theme.fg("muted", effort.padEnd(layout.labelWidth))}` : "";
		primary = `${nameCell}${gap}${leftArrow} ${squares} ${rightArrow}${label}`;
	} else {
		primary = name;
	}

	// Truncate before painting, never after: a cut inside the bold wrapper would
	// drop its closing code and bleed the weight across the rest of the line.
	const gapBeforeTrailing = trailingWidth > 0 ? 2 : 0;
	const capped = truncateToWidth(primary, Math.max(1, inner - trailingWidth - gapBeforeTrailing), "…");
	const painted = selected ? theme.bold(theme.fg("text", capped)) : theme.fg("text", capped);
	const filler = " ".repeat(Math.max(0, inner - visibleWidth(capped) - trailingWidth));
	return `${cursor}${painted}${filler}${trailing}`;
}

function formatPrice(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
	if (value === 0) return "$0";
	const rounded = Math.round(value * 1000) / 1000;
	return rounded === 0 ? "<$0.001" : `$${rounded}`;
}

/**
 * Per-million-token prices for the highlighted model.
 *
 * This is the detail the old list carried as a second "Model Name" line, which
 * became redundant once the name became the row itself. Price is what you
 * actually weigh when two models are otherwise interchangeable.
 */
export function renderPricePanel(cost: ModelCost | undefined, width: number): string[] {
	const entries: [string, string][] = [
		["Input", formatPrice(cost?.input)],
		["Cached input", formatPrice(cost?.cacheRead)],
		["Output", formatPrice(cost?.output)],
	];
	const unit = theme.fg("muted", PRICE_UNIT_TEXT);
	const lines: string[] = [""];
	if (width >= PRICE_WIDE_LAYOUT_MIN_WIDTH) {
		const columnWidth = Math.min(
			PRICE_COLUMN_MAX_WIDTH,
			Math.max(
				PRICE_COLUMN_MIN_WIDTH,
				Math.floor((width - CURSOR_WIDTH - (visibleWidth(PRICE_UNIT_TEXT) + 1)) / entries.length),
			),
		);
		const row = (index: 0 | 1) =>
			entries
				.map((entry) => entry[index] + " ".repeat(Math.max(0, columnWidth - visibleWidth(entry[index]))))
				.join("");
		lines.push(`${theme.fg("muted", row(0))} ${unit}`, theme.fg("text", row(1)));
	} else {
		lines.push(
			...entries.map(([label, value], index) => {
				const suffix = index === entries.length - 1 ? ` ${unit}` : "";
				return `${theme.fg("muted", `${label}:`)} ${theme.fg("text", value)}${suffix}`;
			}),
		);
	}
	return lines.map((line) => truncateToWidth(`  ${line}`, width, "…"));
}
