/**
 * Presentation for the shell tools.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `bash.ts` spreads these into the shell
 * tool definition, so the tool's public shape is unchanged.
 */

import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { formatHiddenLines, previewLineCount } from "../../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { BashToolDetails } from "../bash.ts";
import { getTextOutput, invalidArgText, str } from "../render-utils.ts";
import { parseShellOperation } from "../shell-operation.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

const BASH_PREVIEW_LINES = 5;
export const BASH_UPDATE_THROTTLE_MS = 100;
type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};
class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}
export function formatShellCall(
	args: { command?: string; timeout?: number; handle?: string; kill?: boolean } | undefined,
	prompt: string,
): string {
	const invalid = () => theme.fg("toolTitle", theme.bold(`${prompt} ${invalidArgText(theme)}`));
	const command = str(args?.command);
	const handle = str(args?.handle);
	if (command === null || handle === null) return invalid();

	const parsed = parseShellOperation(args ?? {});
	if (!parsed.ok) {
		// Arguments still arriving name no operation yet, so they render as a
		// placeholder. Anything that already names one and still fails to parse is
		// rejected at execution, and naming its command would describe something
		// that never runs.
		if (!command && !handle) {
			return theme.fg("toolTitle", theme.bold(`${prompt} ${theme.fg("toolOutput", "...")}`));
		}
		return invalid();
	}
	if (parsed.operation.kind !== "run") {
		const suffix = parsed.operation.kind === "kill" ? " · kill" : "";
		return theme.fg("toolTitle", theme.bold(`${prompt} ${parsed.operation.handle}${suffix}`));
	}
	const timeoutSuffix = parsed.operation.timeout ? theme.fg("muted", ` (timeout ${parsed.operation.timeout}s)`) : "";
	return theme.fg("toolTitle", theme.bold(`${prompt} ${parsed.operation.command}`)) + timeoutSuffix;
}
function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
): void {
	const state = component.state;
	component.clear();

	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						let preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						const shown = previewLineCount(preview.visualLines.length + preview.skippedCount, BASH_PREVIEW_LINES);
						if (shown > preview.visualLines.length) preview = truncateToVisualLines(styledOutput, shown, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint = formatHiddenLines(state.cachedSkipped, "earlier");
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}
}

/** Shell renderers are shared by bash and powershell, which differ only in the prompt they display. */
export function createShellRenderers(prompt: string): Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> {
	return {
		renderCall(args, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatShellCall(
					args as { command?: string; timeout?: number; handle?: string; kill?: boolean } | undefined,
					prompt,
				),
			);
			return text;
		},
		renderResult(result, options, _theme, context) {
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(component, result as any, options, context.showImages);
			component.invalidate();
			return component;
		},
	};
}
