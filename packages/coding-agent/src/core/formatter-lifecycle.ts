/**
 * VF.5 plus PS.2: the formatter lifecycle. A formatter runs against an
 * isolated copy of the workspace, never the workspace itself, and only the
 * changes matching its declared paths are promoted back. An undeclared write
 * is left behind in the discarded stage directory, so the live workspace never
 * holds bytes the policy did not declare.
 *
 * This replaces post-hoc reporting. The earlier lifecycle ran the formatter in
 * the live workspace and listed undeclared writes afterwards, which is a
 * report, not a boundary: the stray bytes were already on disk. `status` is
 * now `scope-violated` whenever a write fell outside the declared set, and
 * that value can never read as `passed`.
 *
 * What this does NOT confine, deliberately and recorded rather than implied:
 * a formatter writing to an absolute path outside the workspace, or reaching
 * the network. Those are the OS sandbox's job. Copy plus restricted promotion
 * confines workspace mutation, nothing wider.
 *
 * Promotion refuses any file whose live bytes changed during the run, because
 * overwriting there would destroy a concurrent edit by the user. Such a run
 * fails rather than reverting the user's work.
 *
 * The snapshot is a bounded walk (harness directories skipped, per-file and
 * total byte caps). `truncatedSnapshot` is set when coverage was cut short, so
 * an "unchanged" verdict can be read with the right suspicion.
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	type Dirent,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import type { AuthorizeConfiguredCommand } from "./permissions/policy-command.ts";
import { type PolicyRunStatus, runPolicyCommand } from "./policy-executor.ts";
import type { FormatterPolicy } from "./policy-loader.ts";
import { preparePathOperation, writePreparedPath } from "./tools/path-utils.ts";
import type { WorkspaceArtifactRef, WorkspaceArtifactStore } from "./workspace/artifacts.ts";

/** Per-file hash cap: larger files compare by size plus prefix hash. */
const MAX_HASH_BYTES_PER_FILE = 5 * 1024 * 1024;
/** Prefix length hashed when a file exceeds the per-file cap. */
const LARGE_FILE_PREFIX_BYTES = 64 * 1024;
/** File-count cap for the before/after walk. */
const MAX_SNAPSHOT_FILES = 2_000;
/** Total bytes hashed across one snapshot. */
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
/** Directory names never part of a formatter's honest workspace view. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".apex-code", "sessions"]);

export interface FormatterMutationReport {
	/** Workspace-relative paths (forward slashes) that differ before vs after. */
	changedPaths: string[];
	/** Changed paths the policy did not declare inside its pathScope. */
	undeclaredPaths: string[];
	/** Changed paths whose real location resolves outside the workspace. */
	escapedPaths: string[];
	/** True when nothing in the snapshot differs. */
	unchanged: boolean;
	/** True when the walk hit its caps before covering the whole workspace. */
	truncatedSnapshot: boolean;
}

export interface FormatterEvidence {
	policyId: string;
	executable: string;
	argv: string[];
	cwd: string;
	status: PolicyRunStatus;
	durationMs: number;
	exitCode?: number;
	signal?: string;
	truncated: boolean;
	artifact?: WorkspaceArtifactRef;
}

export interface FormatterRunOutcome {
	status: PolicyRunStatus;
	mutations: FormatterMutationReport;
	evidence: FormatterEvidence;
	refusalReason?: string;
}

export interface FormatterRunOptions {
	workspaceRoot: string;
	signal?: AbortSignal;
	artifactStore?: WorkspaceArtifactStore;
	/** PS.1. A blocked formatter is refused before the snapshot and before the spawn. */
	authorize?: AuthorizeConfiguredCommand;
}

interface ScopeSnapshot {
	/** Workspace-relative path -> content fingerprint. */
	hashes: Map<string, string>;
	truncated: boolean;
}

function matchesAny(relPath: string, patterns: string[]): boolean {
	return patterns.some((pattern) => minimatch(relPath, pattern, { dot: true }));
}

function fingerprint(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function hashFile(absolute: string, size: number): string {
	if (size <= MAX_HASH_BYTES_PER_FILE) return fingerprint(readFileSync(absolute));
	// Oversized file: fingerprint the prefix and let the size field the
	// snapshot caller already compared catch whole-file rewrites.
	return fingerprint(readFileSync(absolute).subarray(0, LARGE_FILE_PREFIX_BYTES));
}

function snapshotScope(root: string, priority: string[], background: string[]): ScopeSnapshot {
	const hashes = new Map<string, string>();
	let truncated = false;
	let budgetFiles = MAX_SNAPSHOT_FILES;
	let budgetBytes = MAX_SNAPSHOT_BYTES;

	const walk = (dir: string): void => {
		if (budgetFiles <= 0 || budgetBytes <= 0) {
			truncated = true;
			return;
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // unreadable directory: skip, never throw
		}
		for (const entry of entries) {
			if (budgetFiles <= 0 || budgetBytes <= 0) {
				truncated = true;
				return;
			}
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(join(dir, entry.name));
				continue;
			}
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			const absolute = join(dir, entry.name);
			const rel = relative(root, absolute).split(sep).join("/");
			if (!matchesAny(rel, priority) && !matchesAny(rel, background)) continue;
			let size: number;
			try {
				size = statSync(absolute).size;
			} catch {
				continue;
			}
			budgetFiles -= 1;
			if (size > budgetBytes) truncated = true;
			try {
				budgetBytes -= Math.min(size, MAX_HASH_BYTES_PER_FILE);
				hashes.set(rel, hashFile(absolute, size));
			} catch {
				// presence without a fingerprint would lie; mark it honestly
				hashes.set(rel, `unreadable:${size}`);
			}
		}
	};

	walk(resolve(root));
	return { hashes, truncated };
}

function insideWorkspace(root: string, absolute: string): boolean {
	// The root itself may sit behind a symlink (macOS /tmp -> /private/tmp):
	// compare the changed path's realpath against the root's realpath, or
	// every workspace under a linked directory reads as an escape.
	let realRoot = root;
	try {
		realRoot = realpathSync(root);
	} catch {
		// root vanished between snapshots: compare as-given
	}
	const rel = relative(realRoot, absolute);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function diffScope(before: ScopeSnapshot, after: ScopeSnapshot): string[] {
	const changed: string[] = [];
	for (const [relPath, beforeHash] of before.hashes) {
		if (after.hashes.get(relPath) !== beforeHash) changed.push(relPath);
	}
	for (const relPath of after.hashes.keys()) {
		if (!before.hashes.has(relPath)) changed.push(relPath);
	}
	return changed.sort();
}

/**
 * Patterns from declaredPaths that remain inside pathScope. A pattern is
 * kept when it equals a scope pattern or a scope pattern is a directory
 * prefix of it; minimatch cannot express containment between globs, so
 * prefix containment is the conservative reading.
 */
function intersectPatterns(declared: string[], scope: string[]): string[] {
	return declared.filter((pattern) =>
		scope.some(
			(scopePattern) =>
				pattern === scopePattern ||
				pattern.startsWith(scopePattern.endsWith("/") ? scopePattern : `${scopePattern}/`),
		),
	);
}

function emptyMutations(): FormatterMutationReport {
	return { changedPaths: [], undeclaredPaths: [], escapedPaths: [], unchanged: true, truncatedSnapshot: false };
}

/** A formatter that never ran. Nothing was spawned, so the mutation report is empty by construction. */
function refused(policy: FormatterPolicy, workspaceRoot: string, reason: string): FormatterRunOutcome {
	return {
		status: "refused",
		mutations: emptyMutations(),
		evidence: {
			policyId: policy.id,
			executable: policy.executable,
			argv: policy.argv,
			cwd: workspaceRoot,
			status: "refused",
			durationMs: 0,
			truncated: false,
		},
		refusalReason: reason,
	};
}

/**
 * Copy the workspace into a private stage directory the formatter runs in.
 * Regular files only: a symlink is not reproduced, so a formatter cannot reach
 * a link's target through the stage, and the live link is never followed on
 * promotion either.
 */
function materializeStage(root: string): { stageRoot: string; truncated: boolean } {
	const stageRoot = mkdtempSync(join(tmpdir(), "apex-formatter-stage-"));
	let truncated = false;
	let budgetFiles = MAX_SNAPSHOT_FILES;
	let budgetBytes = MAX_SNAPSHOT_BYTES;

	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (budgetFiles <= 0 || budgetBytes <= 0) {
				truncated = true;
				return;
			}
			const absolute = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
				mkdirSync(join(stageRoot, relative(root, absolute)), { recursive: true });
				walk(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			let size: number;
			try {
				size = statSync(absolute).size;
			} catch {
				continue;
			}
			budgetFiles -= 1;
			budgetBytes -= size;
			try {
				copyFileSync(absolute, join(stageRoot, relative(root, absolute)));
			} catch {
				truncated = true;
			}
		}
	};

	walk(root);
	return { stageRoot, truncated };
}

interface PromotionResult {
	promoted: string[];
	/** Declared changes refused because the live file changed during the run. */
	conflicted: string[];
}

/**
 * Write the declared stage changes back into the live workspace through the
 * canonical no-follow write path (CA.2), so a symlink planted at the live
 * target is never followed. A file whose live bytes no longer match the
 * pre-run fingerprint belongs to a concurrent editor and is refused.
 */
function promoteDeclaredChanges(
	workspaceRoot: string,
	stageRoot: string,
	declaredChanges: string[],
	preRun: Map<string, string>,
): PromotionResult {
	const promoted: string[] = [];
	const conflicted: string[] = [];
	for (const relPath of declaredChanges) {
		const livePath = join(workspaceRoot, ...relPath.split("/"));
		const stagePath = join(stageRoot, ...relPath.split("/"));
		let liveHash: string | undefined;
		try {
			liveHash = hashFile(livePath, statSync(livePath).size);
		} catch {
			liveHash = undefined;
		}
		if (liveHash !== preRun.get(relPath)) {
			conflicted.push(relPath);
			continue;
		}
		let content: Buffer;
		try {
			content = readFileSync(stagePath);
		} catch {
			conflicted.push(relPath);
			continue;
		}
		try {
			mkdirSync(dirname(livePath), { recursive: true });
			const prepared = preparePathOperation(livePath, workspaceRoot);
			// A symlink at the live target canonicalizes to whatever it points at.
			// Promotion writes only inside the workspace, so a target that resolves
			// out is refused rather than followed.
			if (!insideWorkspace(workspaceRoot, prepared.path.value)) {
				conflicted.push(relPath);
				continue;
			}
			writePreparedPath(prepared, content);
			promoted.push(relPath);
		} catch {
			conflicted.push(relPath);
		}
	}
	return { promoted, conflicted };
}

export async function runFormatterCommand(
	policy: FormatterPolicy,
	options: FormatterRunOptions,
): Promise<FormatterRunOutcome> {
	const workspaceRoot = resolve(options.workspaceRoot);

	// The loader rejects traversal and absolute scope patterns; this is the
	// defensive second gate, because the worst outcome here is running a
	// mutator whose declared scope points outside the workspace.
	const scopePatterns = [...policy.declaredPaths, ...(policy.pathScope ?? [])];
	const offending = scopePatterns.find((pattern) => pattern.includes("..") || isAbsolute(pattern));
	if (offending !== undefined) {
		return refused(
			policy,
			workspaceRoot,
			`declared scope ${JSON.stringify(offending)} must stay inside the workspace`,
		);
	}

	const tracked =
		policy.pathScope === undefined ? policy.declaredPaths : intersectPatterns(policy.declaredPaths, policy.pathScope);

	if (options.authorize !== undefined) {
		const decision = await options.authorize({
			policyId: policy.id,
			executable: policy.executable,
			argv: policy.argv,
			cwd: workspaceRoot,
			writeScope: tracked,
			capabilities: new Set(["exec", "fs.write"]),
			permission: policy.permission,
		});
		if (decision.block) return refused(policy, workspaceRoot, decision.reason ?? "not permitted");
	}

	// Background coverage is everything: an unexpected mutation lives
	// outside every declared pattern, so only a whole-workspace view can
	// report it. Caps bound the walk; truncatedSnapshot carries the doubt.
	const preRun = snapshotScope(workspaceRoot, tracked, ["**"]);
	const stage = materializeStage(workspaceRoot);
	const before = snapshotScope(stage.stageRoot, tracked, ["**"]);
	const run = await runPolicyCommand(policy, {
		workspaceRoot: stage.stageRoot,
		signal: options.signal,
		artifactStore: options.artifactStore,
	});
	const after = snapshotScope(stage.stageRoot, tracked, ["**"]);

	const changedPaths = diffScope(before, after);
	const undeclaredPaths: string[] = [];
	const escapedPaths: string[] = [];
	for (const relPath of changedPaths) {
		if (!matchesAny(relPath, tracked)) undeclaredPaths.push(relPath);
		const absolute = join(stage.stageRoot, ...relPath.split("/"));
		try {
			const real = realpathSync(absolute);
			if (!insideWorkspace(stage.stageRoot, real)) escapedPaths.push(relPath);
		} catch {
			// deleted or unresolvable between snapshots: no live escape to flag
		}
	}

	const declaredChanges = changedPaths.filter(
		(relPath) => matchesAny(relPath, tracked) && !escapedPaths.includes(relPath),
	);
	const promotion = promoteDeclaredChanges(workspaceRoot, stage.stageRoot, declaredChanges, preRun.hashes);
	rmSync(stage.stageRoot, { recursive: true, force: true });

	const outOfScope = undeclaredPaths.length > 0 || escapedPaths.length > 0;
	const status: PolicyRunStatus =
		run.status !== "passed"
			? run.status
			: outOfScope
				? "scope-violated"
				: promotion.conflicted.length > 0
					? "failed"
					: "passed";

	return {
		status,
		mutations: {
			changedPaths,
			undeclaredPaths,
			escapedPaths,
			unchanged: changedPaths.length === 0,
			truncatedSnapshot: preRun.truncated || before.truncated || after.truncated || stage.truncated,
		},
		evidence: {
			policyId: run.policyId,
			executable: run.executable,
			argv: run.argv,
			cwd: run.cwd,
			status,
			durationMs: run.durationMs,
			exitCode: run.exitCode,
			signal: run.signal,
			truncated: run.truncated,
			artifact: run.artifact,
		},
		refusalReason: run.refusalReason,
	};
}
