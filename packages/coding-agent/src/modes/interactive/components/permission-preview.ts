import { type Component, Text } from "@earendil-works/pi-tui";
import type { PermissionPreview } from "../../../core/permissions/responder.ts";
import { theme } from "../theme/theme.ts";

/**
 * Render what a permission prompt is about to authorize.
 *
 * This lives in the TUI rather than in `core/permissions`, so the responder keeps
 * the property it documents: it builds a prompt over the existing `select`
 * primitive and pulls in no rendering of its own.
 *
 * An unavailable preview is drawn as prominently as a diff. A reader who sees
 * nothing cannot tell "this changes nothing" from "we could not read it", and
 * only the second should give them pause.
 */
export function renderPermissionPreview(preview: PermissionPreview): Component {
	if (preview.kind === "unavailable") {
		return new Text(theme.fg("warning", `Cannot show the change. ${preview.reason}`), 1, 0);
	}

	if (preview.kind === "summary") {
		return new Text(preview.lines.map((line) => theme.fg("muted", line)).join("\n"), 1, 0);
	}

	const body = preview.lines.map((line) => {
		if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
		if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
		return theme.fg("toolDiffContext", line);
	});
	if (preview.omittedLines > 0) {
		body.push(theme.fg("muted", `... ${preview.omittedLines} more lines not shown`));
	}
	return new Text([theme.fg("muted", preview.path), ...body].join("\n"), 1, 0);
}
