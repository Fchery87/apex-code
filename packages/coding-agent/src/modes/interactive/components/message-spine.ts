import { theme } from "../theme/theme.ts";

/**
 * Put the accent spine in the first padding column of an already-rendered line.
 *
 * Both message components render their children with `outputPad` leading spaces, so the
 * first column is padding and is free to take. Prefixing the spine instead makes the line
 * one column wider than the width it was rendered for, and nothing downstream re-flows it:
 * the user-message line then overflows the terminal by one column, and the assistant path
 * hands it to `truncateToWidth`, which clips real content and appends an ellipsis.
 *
 * A line that does not start with a padding column is returned unchanged, because there is
 * no free column to take and widening it is the defect this exists to avoid.
 */
export function withAccentSpine(line: string): string {
	if (!line.startsWith(" ")) return line;
	return theme.fg("accent", "│") + line.slice(1);
}
