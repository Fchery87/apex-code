import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export type ToolLifecycle = "queued" | "running" | "done" | "error";
export type ToolSymbolPreset = "unicode" | "ascii";

const LIFECYCLE_SYMBOLS: Record<ToolSymbolPreset, Record<ToolLifecycle, string>> = {
	unicode: { queued: "○", running: "◌", done: "✓", error: "✗" },
	ascii: { queued: "[ ]", running: "[~]", done: "[x]", error: "[!]" },
};

const CONTROL_SEQUENCE = /\x1b\[[0-9;]*[A-Za-z]|\x1b_[^\x07]*\x07/y;

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

function lifecycleBackground(lifecycle: ToolLifecycle): "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" {
	if (lifecycle === "done") return "toolSuccessBg";
	if (lifecycle === "error") return "toolErrorBg";
	return "toolPendingBg";
}

function paintBackground(line: string, background: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"): string {
	let output = "";
	let visibleText = "";
	let index = 0;

	const flush = () => {
		if (!visibleText) return;
		output += theme.bg(background, visibleText);
		visibleText = "";
	};

	while (index < line.length) {
		CONTROL_SEQUENCE.lastIndex = index;
		const control = CONTROL_SEQUENCE.exec(line);
		if (control) {
			flush();
			output += control[0];
			index = CONTROL_SEQUENCE.lastIndex;
			continue;
		}
		visibleText += line[index];
		index += 1;
	}
	flush();
	return output;
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
		return panelLines.map((line) => {
			const clipped = truncateToWidth(line, innerWidth, "");
			const rightPadding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
			return paintBackground(`${" ".repeat(padding)}${clipped}${rightPadding}${" ".repeat(padding)}`, background);
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
