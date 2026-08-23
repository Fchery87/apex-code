import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export type ToolLifecycle = "queued" | "running" | "done" | "error";
export type ToolSymbolPreset = "unicode" | "ascii";

const LIFECYCLE_SYMBOLS: Record<ToolSymbolPreset, Record<ToolLifecycle, string>> = {
	unicode: { queued: "○", running: "◌", done: "✓", error: "✗" },
	ascii: { queued: "[ ]", running: "[~]", done: "[x]", error: "[!]" },
};

function lifecycleColor(lifecycle: ToolLifecycle): "dim" | "warning" | "success" | "error" {
	switch (lifecycle) {
		case "queued":
			return "dim";
		case "running":
			return "warning";
		case "done":
			return "success";
		case "error":
			return "error";
	}
}

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
