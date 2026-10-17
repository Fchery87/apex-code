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
	const prefix = lines[0].startsWith("Error: Traceback ") ? "Error: " : "";
	if (lines[0].slice(prefix.length).startsWith("Traceback ")) {
		const raised = lines.filter((line) => !/^\s/.test(line)).at(-1);
		if (raised && raised !== lines[0]) return `${prefix}${raised.trim()}`;
	}
	return lines[0].trim();
}

/** A folded error line: the summary followed by the expand hint. */
export function collapsedErrorLine(styledSummary: string): string {
	return `${styledSummary} ${keyHint("app.tools.expand", "to expand")}`;
}

/** A command may print successful progress before the diagnostic that stops it. */
export function summarizeOperationError(text: string): string | undefined {
	const lines = nonEmptyLines(text);
	const traceback = lines.findIndex((line) => line.startsWith("Traceback ") || line.startsWith("Error: Traceback "));
	if (traceback >= 0) return summarizeError(lines.slice(traceback).join("\n"));
	const diagnostic =
		lines.find((line) => /(?:^|\s)(?:[\w.]*Error|Exception|fatal):/i.test(line)) ??
		lines.find((line) => /\b(?:error|failed|failure|fail|denied|exception|fatal)\b/i.test(line));
	return diagnostic?.trim() ?? lines.find((line) => !/^\s*(?:PASS|passed|ok|✓)\b/i.test(line))?.trim();
}
