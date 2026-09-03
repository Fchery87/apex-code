import { existsSync } from "node:fs";
import type { WorkspaceStateComparison, WorkspaceStateRecord } from "./state.ts";
import { WORKSPACE_RECORD_VERSION } from "./state.ts";

/** Upper bound on `changedPaths` carried in one comparison record. */
export const MAX_CHANGED_PATHS = 200;

export type WorkspaceComparisonOutcome = Pick<WorkspaceStateComparison, "result" | "changedPaths" | "warnings">;

export interface WorkspaceComparisonOptions {
	/** Probe for stored patch artifacts; defaults to existence on disk. */
	artifactProbe?: (storePath: string) => boolean;
}

function pathTupleKey(path: {
	path: string;
	kind: string;
	staged?: boolean;
	unstaged?: boolean;
	ignored?: boolean;
	contentHash?: string;
}): string {
	return [
		path.path,
		path.kind,
		path.staged ? "s" : "",
		path.unstaged ? "u" : "",
		path.ignored ? "i" : "",
		path.contentHash ?? "",
	].join("\u0000");
}

function changedPathsBetween(stored: WorkspaceStateRecord, fresh: WorkspaceStateRecord, warnings: string[]): string[] {
	const storedKeys = new Map<string, string>();
	for (const p of stored.paths) storedKeys.set(p.path, pathTupleKey(p));
	const freshKeys = new Map<string, string>();
	for (const p of fresh.paths) freshKeys.set(p.path, pathTupleKey(p));

	const changed = new Set<string>();
	for (const [path, key] of storedKeys) {
		if (freshKeys.get(path) !== key) changed.add(path);
	}
	for (const [path, key] of freshKeys) {
		if (storedKeys.get(path) !== key) changed.add(path);
	}
	const sorted = [...changed].sort();
	if (sorted.length > MAX_CHANGED_PATHS) {
		warnings.push(`changed path list truncated at ${MAX_CHANGED_PATHS} of ${sorted.length} entries`);
		return sorted.slice(0, MAX_CHANGED_PATHS);
	}
	return sorted;
}

/**
 * WS.5: compare fresh workspace state against a stored observation (spec
 * 2026-09-01-harness-correctness-and-workspace-state.md § 3). Pure: same
 * inputs, same outcome. `unavailable` — the workspace could not be observed
 * now; `inconclusive` — no reliable comparison could be established, so no
 * drift claim is made in either direction; drift is never silently hidden:
 * an old patch is never presented as current state.
 */
export function compareWorkspaceObservations(
	stored: WorkspaceStateRecord,
	fresh: WorkspaceStateRecord | undefined,
	options: WorkspaceComparisonOptions = {},
): WorkspaceComparisonOutcome {
	const warnings: string[] = [];

	if (!fresh || fresh.status === "failed" || fresh.status === "unsupported") {
		return { result: "unavailable", warnings };
	}
	if (fresh.status === "incomplete") {
		warnings.push("fresh observation is incomplete; comparison is not reliable");
		return { result: "inconclusive", warnings };
	}
	if (stored.status === "incomplete") {
		warnings.push("stored observation is incomplete; comparison is not reliable");
		return { result: "inconclusive", warnings };
	}
	if (stored.status !== "observed") {
		warnings.push("stored observation has no comparable baseline");
		return { result: "inconclusive", warnings };
	}

	const storedBase = stored.base;
	const freshBase = fresh.base;
	if (!storedBase?.worktreeDigest || !freshBase?.worktreeDigest) {
		warnings.push("worktree digest missing on one side; comparison is not reliable");
		return { result: "inconclusive", warnings };
	}

	const sameIndex = (storedBase.indexDigest ?? "") === (freshBase.indexDigest ?? "");
	const sameWorktree = storedBase.worktreeDigest === freshBase.worktreeDigest;

	if (stored.patchArtifactRef) {
		const probe = options.artifactProbe ?? ((p: string) => existsSync(p));
		if (!probe(stored.patchArtifactRef.file)) {
			warnings.push(`stored workspace patch artifact ${stored.patchArtifactRef.artifactId} is missing on disk`);
		}
	}

	if (sameIndex && sameWorktree) {
		return { result: "same", warnings };
	}
	const changedPaths = changedPathsBetween(stored, fresh, warnings);
	return { result: "drifted", changedPaths, warnings };
}

/** Shape of a persisted comparison record, minus what the caller supplies. */
export type WorkspaceComparisonFields = WorkspaceComparisonOutcome & {
	comparedAt: string;
	comparedToObservationId: string;
	version: typeof WORKSPACE_RECORD_VERSION;
};

/** Build the record handed to appendWorkspaceComparison. */
export function buildWorkspaceComparison(
	comparedToObservationId: string,
	outcome: WorkspaceComparisonOutcome,
	now: () => string = () => new Date().toISOString(),
): WorkspaceStateComparison {
	return {
		version: WORKSPACE_RECORD_VERSION,
		comparedAt: now(),
		comparedToObservationId,
		result: outcome.result,
		changedPaths: outcome.changedPaths,
		warnings: outcome.warnings,
	};
}
