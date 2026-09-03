import type { WorkspaceStatePath, WorkspaceStateRecord } from "./state.ts";

/**
 * Bounded, model-facing projection of a workspace observation (spec
 * 2026-09-01-harness-correctness-and-workspace-state.md § 3): status, base
 * identity, grouped paths, coverage/incomplete notices. Never hashes, never
 * artifact bytes, never absolute workspace paths.
 */

const MAX_PATHS_PER_GROUP = 20;
const HEAD_ABBREV = 7;

function groupLabel(path: WorkspaceStatePath): string {
	if (path.ignored) return "ignored";
	const flags = [path.staged ? "staged" : "", path.unstaged ? "unstaged" : ""].filter(Boolean).join(" + ");
	return flags ? `${path.kind} (${flags})` : path.kind;
}

function pathLabel(path: WorkspaceStatePath): string {
	if (path.kind === "renamed" && path.previousPath) {
		return `${path.previousPath} -> ${path.path}`;
	}
	return path.path;
}

export function formatWorkspaceProjection(record: WorkspaceStateRecord): string {
	const headerParts = [`Workspace: ${record.status}`];
	if (record.base?.branch) headerParts.push(`branch ${record.base.branch}`);
	if (record.base?.headCommit) headerParts.push(`HEAD ${record.base.headCommit.slice(0, HEAD_ABBREV)}`);
	const lines: string[] = [headerParts.join(" · ")];

	if (record.status === "unsupported") {
		lines.push("No workspace adapter applies to this workspace; treat the workspace as unknown.");
	} else if (record.status === "failed") {
		lines.push("Workspace capture failed; treat this snapshot as absent, not as current.");
	} else if (record.status === "incomplete") {
		lines.push("Configured limits prevented a complete capture; treat this snapshot as partial.");
	}

	const groups = new Map<string, string[]>();
	for (const path of record.paths) {
		const label = groupLabel(path);
		const group = groups.get(label) ?? [];
		group.push(pathLabel(path));
		groups.set(label, group);
	}
	const labels = [...groups.keys()].sort();
	for (const label of labels) {
		const paths = groups.get(label)!;
		const shown = paths.slice(0, MAX_PATHS_PER_GROUP);
		const rest = paths.length - shown.length;
		lines.push(`${label}: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`);
	}

	if (record.warnings.length > 0) {
		lines.push(`Workspace notices: ${record.warnings.join("; ")}`);
	}
	return lines.join("\n");
}
