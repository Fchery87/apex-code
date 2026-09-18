/**
 * Parsing helpers for rendered model-selector rows.
 *
 * A model row is `<cursor> <display name>` with a right-aligned trailing cluster
 * of ` · `-joined context: an optional provider badge, then the model id, then
 * any of `default` and `current`. The name and the cluster are always separated
 * by at least two spaces, which is what tells them apart here.
 *
 * Other lines in the overlay also open with two leading columns — the scroll
 * indicator, the price panel, the refresh status — so a candidate cluster only
 * counts when every one of its segments looks like an identifier.
 */

const CURSOR = /^(?:→|\s) /;
const IDENTIFIER = /^[A-Za-z0-9._:/-]+$/;
const STATUS_SEGMENTS = new Set(["default", "current"]);

function rowId(line: string): string | undefined {
	if (!CURSOR.test(line)) return undefined;
	const body = line.slice(2).replace(/\s+$/, "");
	if (body.length === 0) return undefined;
	const chunks = body.split(/\s{2,}/);
	const cluster = chunks[chunks.length - 1];
	if (cluster === undefined) return undefined;
	const segments = cluster.split(" · ");
	if (!segments.every((segment) => IDENTIFIER.test(segment))) return undefined;
	while (segments.length > 1 && STATUS_SEGMENTS.has(segments[segments.length - 1] ?? "")) segments.pop();
	return segments[segments.length - 1];
}

/** Model ids of every rendered row, in render order. */
export function selectorRowIds(rendered: string): string[] {
	return rendered
		.split("\n")
		.map(rowId)
		.filter((id): id is string => id !== undefined);
}

/** Model id of the highlighted row. */
export function selectedRowId(rendered: string): string | undefined {
	const line = rendered.split("\n").find((l) => l.startsWith("→ "));
	return line ? rowId(line) : undefined;
}
