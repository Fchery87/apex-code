import type { ModelCost, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	composeModelRow,
	type EffortLayoutRow,
	getEffortLayout,
	getTrailingWidth,
	NO_EFFORT_CLUSTER,
	renderPricePanel,
	type TrailingSegment,
} from "../src/modes/interactive/components/model-row.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

const ID = (text: string): TrailingSegment => ({ text, priority: 2 });
const PROVIDER = (text: string): TrailingSegment => ({ text, priority: 0 });
const CURRENT = (text: string): TrailingSegment => ({ text, priority: 3 });

function reasoningRow(name: string, trailing: TrailingSegment[] = [ID("claude-opus-5")]): EffortLayoutRow {
	return { name, levels: LEVELS, trailingSegments: trailing };
}

describe("model row", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("drops the cheapest context first, not the leftmost", () => {
		const segments = [PROVIDER("anthropic"), ID("claude-opus-5")];
		expect(getTrailingWidth(segments, 120)).toBe(visibleWidth("anthropic · claude-opus-5"));
		expect(getTrailingWidth(segments, 30)).toBe(visibleWidth("claude-opus-5"));
	});

	it("keeps the active marker over the id, which the row's name already implies", () => {
		// Reading order stays id-then-status; only the drop order is by priority.
		const segments = [ID("claude-sonnet-4-5"), CURRENT("current")];
		const wide = stripAnsi(
			composeModelRow({
				name: "Claude Sonnet 4.5",
				levels: [],
				effort: undefined,
				trailingSegments: segments,
				selected: false,
				layout: NO_EFFORT_CLUSTER,
				width: 80,
			}),
		);
		expect(wide).toMatch(/claude-sonnet-4-5 · current$/);

		const narrow = stripAnsi(
			composeModelRow({
				name: "Claude Sonnet 4.5",
				levels: [],
				effort: undefined,
				trailingSegments: segments,
				selected: false,
				layout: NO_EFFORT_CLUSTER,
				width: 30,
			}),
		);
		expect(narrow).toContain("current");
		expect(narrow).not.toContain("claude-sonnet-4-5");
	});

	it("gives up the effort label before the cluster itself", () => {
		const rows = [reasoningRow("Claude Opus 5"), reasoningRow("Claude Sonnet 5")];

		expect(getEffortLayout(rows, 120)).toMatchObject({ showCluster: true, showLabel: true });
		expect(getEffortLayout(rows, 44)).toMatchObject({ showCluster: true, showLabel: false });
		expect(getEffortLayout(rows, 36)).toEqual(NO_EFFORT_CLUSTER);
	});

	it("has no cluster at all when nothing on the page has effort to dial", () => {
		const rows: EffortLayoutRow[] = [{ name: "GPT-5", levels: [], trailingSegments: [ID("gpt-5")] }];

		expect(getEffortLayout(rows, 120)).toEqual(NO_EFFORT_CLUSTER);
	});

	it("fills the row to the render width and ends it on the trailing context", () => {
		const row = stripAnsi(
			composeModelRow({
				name: "Claude Opus 5",
				levels: [],
				effort: undefined,
				trailingSegments: [PROVIDER("anthropic"), ID("claude-opus-5")],
				selected: true,
				layout: NO_EFFORT_CLUSTER,
				width: 60,
			}),
		);

		expect(visibleWidth(row)).toBe(60);
		expect(row).toMatch(/^→ Claude Opus 5 {2,}anthropic · claude-opus-5$/);
	});

	it("fills one square per level reached, and leaves the rest hollow", () => {
		const rows = [reasoningRow("Claude Opus 5")];
		const squares = (effort: ModelThinkingLevel) =>
			stripAnsi(
				composeModelRow({
					name: "Claude Opus 5",
					levels: LEVELS,
					effort,
					trailingSegments: [ID("claude-opus-5")],
					selected: true,
					layout: getEffortLayout(rows, 120),
					width: 120,
				}),
			);

		expect(squares("off")).toContain("□□□□");
		expect(squares("low")).toContain("■■□□");
		expect(squares("high")).toContain("■■■■");
	});

	it("shows an em dash for a price the catalog does not carry", () => {
		const panel = renderPricePanel(undefined, 120).map(stripAnsi).join("\n");

		expect(panel).toContain("—");
		expect(panel).toContain("$ / 1M tokens");
	});

	it("stacks the prices one per line when the terminal is narrow", () => {
		const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } as ModelCost;
		const panel = renderPricePanel(cost, 40).map(stripAnsi);

		expect(panel).toContainEqual(expect.stringContaining("Input: $3"));
		expect(panel).toContainEqual(expect.stringContaining("Cached input: $0.3"));
		expect(panel).toContainEqual(expect.stringContaining("Output: $15"));
	});
});
