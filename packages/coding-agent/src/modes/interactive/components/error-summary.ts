import { keyHint } from "./keybinding-hints.ts";

function nonEmptyLines(text: string): string[] {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.filter((line) => line.trim() !== "");
}

/**
 * The one line that stands for a multi-line error while it is collapsed, or
 * undefined when the error is already one line and there is nothing to fold.
 *
 * A Python traceback leads with frames and ends with the raised error, so the
 * last unindented line names it; anything else leads with its headline.
 */
export function summarizeError(text: string): string | undefined {
	const lines = nonEmptyLines(text);
	if (lines.length <= 1) return undefined;
	if (lines[0].startsWith("Traceback ")) {
		const raised = lines.filter((line) => !/^\s/.test(line)).at(-1);
		if (raised && raised !== lines[0]) return raised.trim();
	}
	return lines[0].trim();
}

/** A folded error line: the summary followed by the expand hint. */
export function collapsedErrorLine(styledSummary: string): string {
	return `${styledSummary} ${keyHint("app.tools.expand", "to expand")}`;
}
