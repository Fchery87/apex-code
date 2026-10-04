import type { ChatDetail } from "../../../core/settings-manager.ts";
/**
 * Component for displaying bash command execution with streaming output.
 */

import { Container, Loader, Spacer, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { summarizeOperationError } from "./error-summary.ts";
import { formatHiddenLines, keyHint, keyText, previewLineCount } from "./keybinding-hints.ts";
import { countOutputLines, renderCompactOperationRow, type ToolSymbolPreset } from "./tool-panel.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

// Preview line limit when not expanded (matches tool execution behavior)
const PREVIEW_LINES = 20;

export class BashExecutionComponent extends Container {
	private command: string;
	private outputLines: string[] = [];
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private loader: Loader;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	private collapsedOverride = false;
	private chatDetail: ChatDetail = "details";
	private symbolPreset: ToolSymbolPreset;
	private contentContainer: Container;
	// Display rebuild cache: appendOutput and invalidate() fire far more often
	// than the displayed state changes, and the rebuild is allocation-heavy.
	private displayState?: { key: string };
	private compactSummary = "0 output lines";

	constructor(command: string, ui: TUI, excludeFromContext = false, symbolPreset: ToolSymbolPreset = "unicode") {
		super();
		this.command = command;
		this.symbolPreset = symbolPreset;

		// Use dim border for excluded-from-context commands (!! prefix)
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		const borderColor = (str: string) => theme.fg(colorKey, str);

		// Add spacer
		this.addChild(new Spacer(1));

		// Top border
		this.addChild(new DynamicBorder(borderColor));

		// Content container (holds dynamic content between borders)
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Command header
		const header = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 1, 0);
		this.contentContainer.addChild(header);

		// Loader
		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(colorKey, spinner),
			(text) => theme.fg("muted", text),
			`Running... (${keyText("tui.select.cancel")} to cancel)`, // Plain text for loader
		);
		this.contentContainer.addChild(this.loader);

		// Bottom border
		this.addChild(new DynamicBorder(borderColor));
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		this.collapsedOverride = false;
		this.expanded = expanded;
		this.updateDisplay();
	}

	setChatDetail(detail: ChatDetail): void {
		this.chatDetail = detail;
		this.setExpanded(detail === "all");
	}

	toggleExpanded(): void {
		this.expanded = !this.expanded;
		this.collapsedOverride = !this.expanded;
		this.updateDisplay();
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (event.type !== "click" || event.button !== "left" || event.y < 0 || event.y >= event.height) return undefined;
		if (event.y !== (this.isCompact() ? 0 : 2)) return undefined;
		this.toggleExpanded();
		return {
			handled: true,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}

	private isCompact(): boolean {
		return this.collapsedOverride || (this.chatDetail === "overview" && !this.expanded);
	}

	override render(width: number): string[] {
		if (!this.isCompact()) return super.render(width);
		return renderCompactOperationRow(
			{
				label: `$ ${this.command}`,
				lifecycle: this.status === "running" ? "running" : this.status === "complete" ? "done" : "error",
				symbolPreset: this.symbolPreset,
				summary: this.compactSummary,
			},
			width,
		);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	appendOutput(chunk: string): void {
		// Strip ANSI codes and normalize line endings
		// Note: binary data is already sanitized in tui-renderer.ts executeBashCommand
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// Append to output lines
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// Append first chunk to last line (incomplete line continuation)
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.updateDisplay();
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		// Stop loader
		this.loader.stop();

		this.updateDisplay();
	}

	private updateDisplay(): void {
		// Skip the rebuild when nothing observable changed: appendOutput runs
		// per output chunk and invalidate() runs per TUI invalidation, while
		// the display only depends on line count, expansion, and completion
		// state. The last line's length moves with intra-line appends.
		const lastLineLength = this.outputLines[this.outputLines.length - 1]?.length ?? 0;
		const key = `${this.outputLines.length}:${lastLineLength}:${this.expanded}:${this.status}:${this.exitCode ?? "none"}:${this.truncationResult !== undefined}:${this.fullOutputPath !== undefined}`;
		if (this.displayState?.key === key) return;
		this.displayState = { key };

		// Apply truncation for LLM context limits (same limits as bash tool)
		const fullOutput = this.outputLines.join("\n");
		const outputLineCount = countOutputLines(fullOutput);
		const diagnostic = this.status === "error" ? summarizeOperationError(fullOutput) : undefined;
		this.compactSummary =
			this.status === "cancelled"
				? "cancelled"
				: this.status === "error"
					? `exit ${this.exitCode}${diagnostic ? `: ${diagnostic}` : ""}`
					: `${outputLineCount} output line${outputLineCount === 1 ? "" : "s"}`;
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		// Get the lines to potentially display (after context truncation)
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];

		// Apply preview truncation based on expanded state
		const previewLogicalLines = availableLines.slice(-previewLineCount(availableLines.length, PREVIEW_LINES));
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		// Rebuild content container
		this.contentContainer.clear();

		// Command header
		const header = new Text(theme.fg("bashMode", theme.bold(`$ ${this.command}`)), 1, 0);
		this.contentContainer.addChild(header);

		// Output
		if (availableLines.length > 0) {
			// A preview that hides no line shows all of it. Capping its rows as well would cut
			// wrapped lines with nothing to say so, since the hint counts hidden lines.
			if (this.expanded || hiddenLineCount === 0) {
				// Show all lines
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				// Use shared visual truncation utility with width-aware caching
				const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
				const styledInput = `\n${styledOutput}`;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						if (cachedLines === undefined || cachedWidth !== width) {
							const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, 1);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return cachedLines ?? [];
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		// Loader or status
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// Show how many lines are hidden (collapsed preview)
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(
						`${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`,
					);
				} else {
					statusParts.push(formatHiddenLines(hiddenLineCount, "earlier"));
				}
			}

			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
			}

			// Add truncation warning (context truncation, not preview truncation)
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, 1, 0));
			}
		}
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}

	/**
	 * Stop the animated loader. Session swaps clear containers wholesale,
	 * which detaches children without stopping their timers; an in-flight
	 * component left uncompleted would otherwise animate forever.
	 */
	dispose(): void {
		this.loader.stop();
	}
}
