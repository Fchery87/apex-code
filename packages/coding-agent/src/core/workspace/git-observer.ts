import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, win32 as pathWin32, relative, sep } from "node:path";
import {
	WORKSPACE_RECORD_VERSION,
	type WorkspaceStateCoverage,
	type WorkspaceStatePath,
	type WorkspaceStateRecord,
} from "./state.ts";

/**
 * Read-only Git workspace observation (spec 2026-09-01-harness-correctness-
 * and-workspace-state.md § 1).
 *
 * The adapter never mutates repository state: `HEAD`, the current branch, the
 * index, the worktree, the stash, and local config are only read. Optional
 * index locks are disabled (`GIT_OPTIONAL_LOCKS=0`) so even `git status`
 * cannot refresh the on-disk index. It never walks the workspace; all path
 * knowledge comes from git. Symlinks are hashed as link text (what git
 * stores), never followed. Submodule (gitlink) paths carry no worktree hash.
 */

const DEFAULT_MAX_PATHS = 200;
const DEFAULT_MAX_HASH_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const GIT_CONFIG = ["-c", "core.autocrlf=false", "-c", "status.renames=true"];
const UNMERGED_XY = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export interface GitObserveOptions {
	/** Compute per-path content hashes of present files (default true). */
	hashPaths?: boolean;
	/** Maximum number of reported paths (default 200). */
	maxPaths?: number;
	/** Skip hashing files larger than this many bytes (default 5 MiB). */
	maxHashBytes?: number;
	/** Per-command timeout in milliseconds (default 10 000). */
	timeoutMs?: number;
	/** Cancels the observation; the record reports `failed`. */
	signal?: AbortSignal;
}

interface GitRunResult {
	ok: boolean;
	code: number | null;
	stdout: Buffer;
	stderr: string;
	timedOut: boolean;
	spawnError: boolean;
}

function runGit(cwd: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<GitRunResult> {
	return new Promise((resolve) => {
		let stdout = Buffer.alloc(0);
		let stderr = "";
		let timedOut = false;
		let settled = false;
		let child: ChildProcess;
		const finish = (code: number | null, spawnError: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				ok: !spawnError && !timedOut && code === 0,
				code,
				stdout,
				stderr,
				timedOut,
				spawnError,
			});
		};
		const onAbort = () => {
			child?.kill("SIGKILL");
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child?.kill("SIGKILL");
		}, timeoutMs);
		try {
			child = spawn("git", [...GIT_CONFIG, ...args], {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// Observation must leave the on-disk index untouched.
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
			});
		} catch {
			resolve({ ok: false, code: null, stdout, stderr: "", timedOut: false, spawnError: true });
			return;
		}
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = Buffer.concat([stdout, chunk]);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", () => finish(null, true));
		child.on("close", (code) => finish(code, false));
	});
}

function emptyCoverage(): WorkspaceStateCoverage {
	return {
		tracked: false,
		staged: false,
		unstaged: false,
		untracked: false,
		ignored: false,
		hashes: false,
		patch: false,
	};
}

function fullCoverage(): WorkspaceStateCoverage {
	return {
		tracked: true,
		staged: true,
		unstaged: true,
		untracked: true,
		ignored: true,
		hashes: true,
		patch: false,
	};
}

interface ParsedStatusPath {
	x: string;
	y: string;
	path: string;
	previousPath?: string;
}

function parsePorcelainZ(stdout: Buffer): ParsedStatusPath[] {
	const fields = stdout.toString("utf-8").split("\0");
	const parsed: ParsedStatusPath[] = [];
	let i = 0;
	while (i < fields.length) {
		const record = fields[i++];
		if (!record || record.length < 4) continue;
		const entry: ParsedStatusPath = { x: record[0], y: record[1], path: record.slice(3) };
		if (entry.x === "R" || entry.x === "C" || entry.y === "R" || entry.y === "C") {
			entry.previousPath = fields[i++];
		}
		parsed.push(entry);
	}
	return parsed;
}

function classify(entry: ParsedStatusPath): {
	kind: WorkspaceStatePath["kind"];
	staged: boolean;
	unstaged: boolean;
	ignored: boolean;
} {
	const { x, y } = entry;
	if (x === "?" && y === "?") {
		return { kind: "untracked", staged: false, unstaged: false, ignored: false };
	}
	if (x === "!" && y === "!") {
		return { kind: "untracked", staged: false, unstaged: false, ignored: true };
	}
	if (UNMERGED_XY.has(`${x}${y}`)) {
		return {
			kind: x === "D" && y === "D" ? "deleted" : "modified",
			staged: true,
			unstaged: true,
			ignored: false,
		};
	}
	let kind: WorkspaceStatePath["kind"] = "modified";
	if (x === "A" || y === "A" || x === "C" || y === "C") kind = "added";
	else if (x === "D" || y === "D") kind = "deleted";
	else if (x === "R" || y === "R") kind = "renamed";
	return {
		kind,
		staged: x !== " " && x !== "?" && x !== "!",
		unstaged: y !== " " && y !== "?" && y !== "!",
		ignored: false,
	};
}

/** Hash one workspace path: regular files by bytes, symlinks by link text. */
function hashWorkspacePath(
	toplevel: string,
	path: string,
	maxBytes: number,
): { hash?: string; skipped: "size" | "error" | false } {
	try {
		const full = `${toplevel}/${path}`;
		const stat = lstatSync(full);
		if (stat.isFile()) {
			if (stat.size > maxBytes) return { skipped: "size" };
			return { hash: `sha256:${createHash("sha256").update(readFileSync(full)).digest("hex")}`, skipped: false };
		}
		if (stat.isSymbolicLink()) {
			return {
				hash: `sha256:${createHash("sha256").update(readlinkSync(full)).digest("hex")}`,
				skipped: false,
			};
		}
		// Directories (submodule gitlinks) have no worktree content to hash;
		// that is expected, not a coverage gap.
		if (stat.isDirectory()) return { skipped: false };
		return { skipped: "error" };
	} catch {
		return { skipped: "error" };
	}
}

function prefixRelative(prefix: string, path: string): string {
	if (prefix === "" || prefix === ".") return path;
	return `${prefix}/${path}`;
}

/**
 * Observe a Git workspace without mutating it. Returns a version-1
 * `WorkspaceStateRecord`: `unsupported` for non-Git workspaces, `failed`
 * when git could not run or the observation was cancelled, and `incomplete`
 * when a limit truncated the capture. `observed` never implies more than
 * `coverage` states.
 */
export interface ToplevelComparison {
	/** Whether the physically resolved workspace root sits under the toplevel. */
	inside: boolean;
	/** Root path relative to the toplevel; strip this prefix from porcelain paths. */
	prefix: string;
	/** Physically resolved toplevel; base for absolute-path work like hashing. */
	toplevelReal: string;
}

/**
 * Decide containment of the workspace root inside git's toplevel after both
 * sides are physically resolved. Windows spellings diverge from what Node's
 * realpath returns for the same directory (short 8.3 names, drive-letter
 * case), so the win32 branch resolves through the native resolver, folds
 * case for the comparison, and uses win32 path semantics. The platform and
 * resolver are injectable so tests can exercise those branches anywhere.
 */
export function compareToplevel(
	workspaceRoot: string,
	toplevel: string,
	options?: {
		platform?: NodeJS.Platform;
		realpath?: (path: string) => string;
	},
): ToplevelComparison {
	const platform = options?.platform ?? process.platform;
	const isWin32 = platform === "win32";
	const realpath =
		options?.realpath ??
		(isWin32
			? (p: string) => {
					try {
						return realpathSync.native(p);
					} catch {
						return realpathSync(p);
					}
				}
			: realpathSync);
	const rootReal = realpath(workspaceRoot);
	const toplevelReal = realpath(toplevel);
	const pathMod = isWin32 ? pathWin32 : { relative, sep, dirname };
	const fold = (p: string) => (isWin32 ? p.toLowerCase() : p);
	const prefix = pathMod.relative(toplevelReal, rootReal);
	const inside = !(prefix === ".." || prefix.startsWith(`..${pathMod.sep}`) || isAbsolute(prefix));
	if (isWin32 && inside) {
		// Recompute the strip prefix under case folding so a divergent drive or
		// directory case still yields the clean "" or relative form.
		const folded = pathMod.relative(fold(toplevelReal), fold(rootReal));
		return { inside, prefix: folded, toplevelReal };
	}
	return { inside, prefix, toplevelReal };
}

export async function observeWorkspaceGit(
	workspaceRoot: string,
	options?: GitObserveOptions,
): Promise<WorkspaceStateRecord> {
	const maxPaths = options?.maxPaths ?? DEFAULT_MAX_PATHS;
	const maxHashBytes = options?.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const hashPaths = options?.hashPaths ?? true;
	const signal = options?.signal;

	const warnings: string[] = [];
	const failed = (message: string): WorkspaceStateRecord => ({
		version: WORKSPACE_RECORD_VERSION,
		observationId: randomUUID(),
		status: "failed",
		backend: "git",
		workspaceRoot,
		capturedAt: new Date().toISOString(),
		coverage: emptyCoverage(),
		paths: [],
		warnings: [message],
	});

	if (signal?.aborted) {
		return failed("workspace observation cancelled");
	}

	const head = await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"], timeoutMs, signal);
	if (head.spawnError) return failed("git could not be executed");
	if (head.timedOut) return failed("workspace observation timed out");
	if (signal?.aborted) return failed("workspace observation cancelled");
	if (!head.ok) {
		if (/not a git repository/i.test(head.stderr) || head.code === 128) {
			return {
				...failed("not a git repository"),
				status: "unsupported",
			};
		}
		return failed("git rev-parse failed");
	}
	// git resolves the toplevel physically (macOS /tmp -> /private/tmp,
	// Windows drive-letter case and short names), so containment is decided
	// through compareToplevel; otherwise a divergent spelling of the same
	// directory would fail the observation or corrupt every reported path.
	const toplevel = head.stdout.toString("utf-8").trim();
	const comparison = compareToplevel(workspaceRoot, toplevel);
	if (!comparison.inside) {
		return failed("workspace root is outside the repository toplevel");
	}
	const insidePrefix = comparison.prefix;

	const headCommit = await runGit(workspaceRoot, ["rev-parse", "--verify", "HEAD"], timeoutMs, signal);
	const mergeHead = await runGit(workspaceRoot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], timeoutMs, signal);
	if (signal?.aborted) return failed("workspace observation cancelled");
	if (mergeHead.ok) warnings.push("merge in progress");
	const branch = await runGit(workspaceRoot, ["branch", "--show-current"], timeoutMs, signal);

	const headCommitValue = headCommit.ok ? headCommit.stdout.toString("utf-8").trim() : undefined;
	if (!headCommit.ok) warnings.push("unborn HEAD (no commits)");
	const branchValue = branch.ok ? branch.stdout.toString("utf-8").trim() : "";
	if (branchValue === "") warnings.push("detached HEAD");

	// Index baseline.
	const index = await runGit(workspaceRoot, ["ls-files", "--stage", "-z"], timeoutMs, signal);
	if (!index.ok) return failed("git ls-files failed");
	const indexDigest = `sha256:${createHash("sha256").update(index.stdout).digest("hex")}`;

	// Staged / unstaged / untracked / ignored change sets.
	const status = await runGit(
		workspaceRoot,
		["status", "--porcelain", "-z", "--untracked-files=all", "--ignored=matching"],
		timeoutMs,
		signal,
	);
	if (!status.ok) return failed("git status failed");

	const paths: WorkspaceStatePath[] = [];
	let truncated = false;
	let skippedHashes = 0;
	for (const entry of parsePorcelainZ(status.stdout)) {
		if (paths.length >= maxPaths) {
			truncated = true;
			warnings.push(`path list truncated at ${maxPaths} paths`);
			break;
		}
		const { kind, staged, unstaged, ignored } = classify(entry);
		const workspacePath: WorkspaceStatePath = {
			path: prefixRelative(insidePrefix, entry.path),
			kind,
			staged,
			unstaged,
			...(ignored ? { ignored: true } : {}),
			...(entry.previousPath ? { previousPath: prefixRelative(insidePrefix, entry.previousPath) } : {}),
		};
		if (hashPaths && kind !== "deleted") {
			const { hash, skipped } = hashWorkspacePath(comparison.toplevelReal, entry.path, maxHashBytes);
			if (hash) workspacePath.contentHash = hash;
			else if (skipped) skippedHashes++;
		}
		paths.push(workspacePath);
	}
	if (skippedHashes > 0) warnings.push(`content hashing skipped for ${skippedHashes} path(s)`);

	// Digest over exactly the paths this record includes, so a later
	// comparison can cheaply detect that the covered state moved.
	const digestInput = paths
		.map(
			(p) =>
				`${p.path}\0${p.kind}\0${p.staged ? "S" : ""}${p.unstaged ? "U" : ""}${p.ignored ? "I" : ""}\0${p.contentHash ?? ""}\n`,
		)
		.sort()
		.join("");

	return {
		version: WORKSPACE_RECORD_VERSION,
		observationId: randomUUID(),
		status: truncated || skippedHashes > 0 ? "incomplete" : "observed",
		backend: "git",
		workspaceRoot,
		capturedAt: new Date().toISOString(),
		// `hashes` reflects the configured policy: a disabled hash pass is a
		// coverage statement, not an incomplete capture.
		coverage: { ...fullCoverage(), hashes: hashPaths },
		base: {
			...(headCommitValue ? { headCommit: headCommitValue } : {}),
			...(branchValue ? { branch: branchValue } : {}),
			indexDigest,
			...(truncated ? {} : { worktreeDigest: `sha256:${createHash("sha256").update(digestInput).digest("hex")}` }),
		},
		paths,
		warnings,
	};
}
