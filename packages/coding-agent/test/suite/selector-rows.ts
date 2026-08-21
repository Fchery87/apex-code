/**
 * Parsing helpers for rendered model-selector rows.
 *
 * The selector renders a row as `<cursor> <id>`, with an optional ` [provider]` badge and an
 * optional ` ✓` on the current model. The badge only appears when the list spans more than one
 * provider, so tests must not use it to find rows.
 */

const ROW = /^(?:→|\s) (\S+?)(?: \[[^\]]+\])?(?: ✓)?$/;

function rowId(line: string): string | undefined {
	const id = ROW.exec(line.replace(/\s+$/, ""))?.[1];
	// The scroll indicator ("(3/12)") shares the row shape but names no model.
	return id?.startsWith("(") ? undefined : id;
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
