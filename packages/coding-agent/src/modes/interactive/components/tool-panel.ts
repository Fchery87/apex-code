import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { paintBackground, theme } from "../theme/theme.ts";

export type ToolLifecycle = "queued" | "running" | "done" | "error";
export type ToolSymbolPreset = "unicode" | "ascii";

const LIFECYCLE_SYMBOLS: Record<ToolSymbolPreset, Record<ToolLifecycle, string>> = {
	unicode: { queued: "○", running: "◌", done: "✓", error: "✗" },
	ascii: { queued: "[ ]", running: "[~]", done: "[x]", error: "[!]" },
};

/**
 * Running takes the brand accent rather than `warning`. Work in progress is
 * not a caution; amber is reserved for states the user may need to act on.
 */
function lifecycleColor(lifecycle: ToolLifecycle): "dim" | "accent" | "success" | "error" {
	switch (lifecycle) {
		case "queued":
			return "dim";
		case "running":
			return "accent";
		case "done":
			return "success";
		case "error":
			return "error";
	}
}

/**
 * The status spine drawn down the left edge of a tool panel.
 *
 * It is a redundant channel over the lifecycle word in the header, so it is
 * free to lean on colour. The glyph still distinguishes work that has not
 * started from work that has, which is the distinction a glance most needs.
 */
const SPINE_GLYPHS: Record<ToolSymbolPreset, Record<ToolLifecycle, string>> = {
	unicode: { queued: "┆", running: "▌", done: "▌", error: "▌" },
	ascii: { queued: ":", running: "|", done: "|", error: "|" },
};

export function formatToolDuration(durationMs: number): string {
	if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
	if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`;
	return `${Math.round(durationMs / 1000)}s`;
}

export interface ToolStatusLineOptions {
	lifecycle: ToolLifecycle;
	symbolPreset: ToolSymbolPreset;
	durationMs?: number;
}

function lifecycleBackground(lifecycle: ToolLifecycle): "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" {
	if (lifecycle === "done") return "toolSuccessBg";
	if (lifecycle === "error") return "toolErrorBg";
	return "toolPendingBg";
}

/** Prime-style flat shell for renderer-based tool calls. */
export class ToolPanelComponent implements Component {
	private readonly child: Component;
	private readonly options: ToolStatusLineOptions;

	constructor(child: Component, options: ToolStatusLineOptions) {
		this.child = child;
		this.options = options;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const padding = Math.min(2, Math.floor((width - 1) / 2));
		const innerWidth = Math.max(1, width - padding * 2);
		const childLines = this.child.render(innerWidth);
		if (childLines.length === 0) return [];

		const { lifecycle, symbolPreset, durationMs } = this.options;
		const duration = durationMs === undefined ? "" : ` ${formatToolDuration(durationMs)}`;
		const state = theme.fg(
			lifecycleColor(lifecycle),
			`${LIFECYCLE_SYMBOLS[symbolPreset][lifecycle]} ${lifecycle}${duration}`,
		);
		const separator = theme.fg("dim", symbolPreset === "ascii" ? " - " : " · ");
		const stateWidth = visibleWidth(separator) + visibleWidth(state);
		const label = childLines[0].replace(/\s+$/, "");
		const header =
			stateWidth < innerWidth
				? `${truncateToWidth(label, innerWidth - stateWidth, "")}${separator}${state}`
				: truncateToWidth(state, innerWidth, "");
		const panelLines = [header];
		if (childLines.length > 1) panelLines.push("", ...childLines.slice(1));

		const background = lifecycleBackground(lifecycle);
		// The spine occupies the first column of the existing left padding, so it
		// marks state without costing the panel a column of content. Below two
		// columns of padding there is no room for it and it is dropped.
		const showSpine = padding >= 1;
		const spine = showSpine
			? paintBackground(theme.fg(lifecycleColor(lifecycle), SPINE_GLYPHS[symbolPreset][lifecycle]), background)
			: "";
		const leftPadding = " ".repeat(Math.max(0, padding - (showSpine ? 1 : 0)));
		return panelLines.map((line) => {
			const clipped = truncateToWidth(line, innerWidth, "");
			const rightPadding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
			return spine + paintBackground(`${leftPadding}${clipped}${rightPadding}${" ".repeat(padding)}`, background);
		});
	}

	invalidate(): void {
		this.child.invalidate?.();
	}
}

/**
 * Prefixes an existing public tool renderer with Apex-owned lifecycle text.
 * The wrapped renderer receives the remaining width, so its own wrapping and
 * cursor-free layout stay intact without a pi-tui hook.
 */
export class ToolStatusLineComponent implements Component {
	private readonly child: Component;
	private readonly options: ToolStatusLineOptions;

	constructor(child: Component, options: ToolStatusLineOptions) {
		this.child = child;
		this.options = options;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const { lifecycle, symbolPreset, durationMs } = this.options;
		const duration = durationMs === undefined ? "" : ` ${formatToolDuration(durationMs)}`;
		const separator = symbolPreset === "ascii" ? " | " : " · ";
		const plainPrefix = `${LIFECYCLE_SYMBOLS[symbolPreset][lifecycle]} ${lifecycle}${duration}${separator}`;
		const prefix = theme.fg(lifecycleColor(lifecycle), plainPrefix);
		const prefixWidth = visibleWidth(prefix);

		if (prefixWidth >= width) {
			return [truncateToWidth(prefix, width, "")];
		}

		const childWidth = Math.max(1, width - prefixWidth);
		const childLines = this.child.render(childWidth);
		if (childLines.length === 0) return [];

		const continuation = " ".repeat(prefixWidth);
		return childLines.map((line, index) => (index === 0 ? prefix : continuation) + line);
	}

	invalidate(): void {
		this.child.invalidate?.();
	}
}
