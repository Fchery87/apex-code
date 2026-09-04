/**
 * VF.5: the formatter lifecycle (spec
 * 2026-09-01-configured-verification-and-formatting.md § 2). Runs a
 * formatter policy through the VF.3 executor and reports what actually
 * changed against what the policy declared: which declared paths were
 * mutated, which mutations were never declared (or fell outside the
 * policy's pathScope), and which writes escaped the workspace through a
 * symlink. Nothing is reverted — the workspace belongs to the user; the
 * report is the evidence.
 *
 * The snapshot is a bounded walk of the workspace (harness directories
 * skipped, per-file and total byte caps). In-scope declared files are
 * hashed first so their comparison is exact even when the walk hits its
 * caps; `truncatedSnapshot` is set when coverage beyond the declared
 * scope was cut short, so an "unchanged" verdict can be read with the
 * right suspicion.
 */

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { type PolicyRunStatus, runPolicyCommand } from "./policy-executor.ts";
import type { FormatterPolicy } from "./policy-loader.ts";
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
	const rel = relative(resolve(root), absolute);
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
			refusalReason: `declared scope ${JSON.stringify(offending)} must stay inside the workspace`,
		};
	}

	const tracked =
		policy.pathScope === undefined ? policy.declaredPaths : intersectPatterns(policy.declaredPaths, policy.pathScope);

	// Background coverage is everything: an unexpected mutation lives
	// outside every declared pattern, so only a whole-workspace view can
	// report it. Caps bound the walk; truncatedSnapshot carries the doubt.
	const before = snapshotScope(workspaceRoot, tracked, ["**"]);
	const run = await runPolicyCommand(policy, {
		workspaceRoot,
		signal: options.signal,
		artifactStore: options.artifactStore,
	});
	const after = snapshotScope(workspaceRoot, tracked, ["**"]);

	const changedPaths = diffScope(before, after);
	const undeclaredPaths: string[] = [];
	const escapedPaths: string[] = [];
	for (const relPath of changedPaths) {
		if (!matchesAny(relPath, tracked)) undeclaredPaths.push(relPath);
		const absolute = join(workspaceRoot, ...relPath.split("/"));
		try {
			const real = realpathSync(absolute);
			if (!insideWorkspace(workspaceRoot, real)) escapedPaths.push(relPath);
		} catch {
			// deleted or unresolvable between snapshots: no live escape to flag
		}
	}

	return {
		status: run.status,
		mutations: {
			changedPaths,
			undeclaredPaths,
			escapedPaths,
			unchanged: changedPaths.length === 0,
			truncatedSnapshot: before.truncated || after.truncated,
		},
		evidence: {
			policyId: run.policyId,
			executable: run.executable,
			argv: run.argv,
			cwd: run.cwd,
			status: run.status,
			durationMs: run.durationMs,
			exitCode: run.exitCode,
			signal: run.signal,
			truncated: run.truncated,
			artifact: run.artifact,
		},
		refusalReason: run.refusalReason,
	};
}
