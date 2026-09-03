import type { CustomEntry, SessionEntry, SessionManager } from "../session-manager.ts";

/**
 * Workspace state records attached to compaction boundaries.
 *
 * These records reuse the existing additive `custom` session entry type with
 * reserved `customType` discriminants (see the harness-correctness spec, WS.1):
 * they never enter LLM context, readers ignore unknown discriminants, and
 * extension-owned `CompactionEntry.details` stays untouched.
 */

export const CUSTOM_TYPE_OBSERVATION = "apex.workspace.observation";
export const CUSTOM_TYPE_COMPARISON = "apex.workspace.comparison";

/** Current record format version. */
export const WORKSPACE_RECORD_VERSION = 1;

/** Which parts of the workspace an observation actually covered. */
export interface WorkspaceStateCoverage {
	/** Tracked modifications were observed. */
	tracked: boolean;
	/** Staged (index) changes were observed. */
	staged: boolean;
	/** Unstaged changes were observed. */
	unstaged: boolean;
	/** Untracked files were observed. */
	untracked: boolean;
	/** Ignored files were observed. */
	ignored: boolean;
	/** Per-path content hashes were captured. */
	hashes: boolean;
	/** Patch bytes were captured (on disk or inline-limited). */
	patch: boolean;
}

/** The commit a working tree was observed against, when a backend has one. */
export interface WorkspaceBase {
	headCommit?: string;
	branch?: string;
}

/** What kind of change a path carried at capture time. */
export type WorkspacePathKind = "added" | "modified" | "deleted" | "renamed" | "untracked";

/** One path observed in the workspace at a compaction boundary. */
export interface WorkspaceStatePath {
	path: string;
	kind: WorkspacePathKind;
	staged?: boolean;
	unstaged?: boolean;
	/** Content hash at capture time (`sha256:<hex>`), when hashes were covered. */
	contentHash?: string;
	/** Previous path for renames. */
	previousPath?: string;
}

/** Reference to a patch artifact owned by the session artifact store. */
export interface WorkspaceArtifactRef {
	artifactId: string;
	/** Store-relative path inside the session's `.artifacts` directory. */
	file: string;
	/** `sha256:<hex>` of the artifact bytes. */
	sha256: string;
	bytes: number;
}

/** Immutable snapshot of workspace state taken at a compaction boundary. */
export interface WorkspaceStateRecord {
	version: typeof WORKSPACE_RECORD_VERSION;
	/** Stable id, independent of entry ids; comparisons reference it. */
	observationId: string;
	/**
	 * `observed` — full record; `partial` — record with coverage gaps;
	 * `unsupported` — no backend for this workspace; `unavailable` —
	 * observation could not be taken.
	 */
	status: "observed" | "partial" | "unsupported" | "unavailable";
	/** Backend identifier, e.g. `git`; `none` when unsupported. */
	backend: string;
	/** Absolute workspace root the record describes. */
	workspaceRoot: string;
	capturedAt: string;
	coverage: WorkspaceStateCoverage;
	/** The commit the tree was observed against, when applicable. */
	base?: WorkspaceBase;
	paths: WorkspaceStatePath[];
	/** Present when patch capture was enabled and the artifact was stored. */
	patchArtifactRef?: WorkspaceArtifactRef;
	/** Patch byte length when patch data was captured. */
	patchBytes?: number;
	/** False when the patch was truncated by the capture limit. */
	patchComplete?: boolean;
	/** Non-fatal capture notes (truncations, skipped backends, and so on). */
	warnings: string[];
}

/** Result of comparing fresh workspace state against a stored observation. */
export interface WorkspaceStateComparison {
	version: typeof WORKSPACE_RECORD_VERSION;
	comparedAt: string;
	/** The observation this comparison was made against. */
	comparedToObservationId: string;
	/** `same` — no relevant change; `drifted` — state moved; `incomplete` — not fully comparable. */
	result: "same" | "drifted" | "incomplete";
	changedPaths?: string[];
	warnings: string[];
}

/** Append an observation record as a child of the just-appended compaction entry. */
export function appendWorkspaceObservation(session: SessionManager, record: WorkspaceStateRecord): string {
	return session.appendCustomEntry(CUSTOM_TYPE_OBSERVATION, record);
}

/** Append a comparison record to the current path. */
export function appendWorkspaceComparison(session: SessionManager, comparison: WorkspaceStateComparison): string {
	return session.appendCustomEntry(CUSTOM_TYPE_COMPARISON, comparison);
}

/** Read an observation record from a custom entry, or undefined for anything else. */
export function readWorkspaceObservation(entry: SessionEntry | undefined): WorkspaceStateRecord | undefined {
	return readTypedRecord(entry, CUSTOM_TYPE_OBSERVATION);
}

/** Read a comparison record from a custom entry, or undefined for anything else. */
export function readWorkspaceComparison(entry: SessionEntry | undefined): WorkspaceStateComparison | undefined {
	return readTypedRecord(entry, CUSTOM_TYPE_COMPARISON);
}

/** Find the observation record attached as a direct child of a compaction entry. */
export function findWorkspaceObservationForCompaction(
	session: SessionManager,
	compactionId: string,
): { entryId: string; record: WorkspaceStateRecord } | undefined {
	for (const entry of session.getEntries()) {
		if (entry.type !== "custom" || entry.parentId !== compactionId) continue;
		const record = readWorkspaceObservation(entry);
		if (record) return { entryId: entry.id, record };
	}
	return undefined;
}

/** List comparisons recorded against one observation, in path order. */
export function listWorkspaceComparisons(session: SessionManager, observationId: string): WorkspaceStateComparison[] {
	const comparisons: WorkspaceStateComparison[] = [];
	for (const entry of session.getEntries()) {
		const comparison = readWorkspaceComparison(entry);
		if (comparison && comparison.comparedToObservationId === observationId) {
			comparisons.push(comparison);
		}
	}
	return comparisons;
}

/** Lenient read: only well-shaped records of the exact discriminant and version. */
function readTypedRecord<T extends { version: number }>(
	entry: SessionEntry | undefined,
	customType: string,
): T | undefined {
	if (!entry || entry.type !== "custom") return undefined;
	const custom = entry as CustomEntry;
	if (custom.customType !== customType) return undefined;
	const data = custom.data as T | undefined;
	if (!data || typeof data !== "object" || data.version !== WORKSPACE_RECORD_VERSION) {
		return undefined;
	}
	return data;
}
