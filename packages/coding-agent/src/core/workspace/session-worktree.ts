import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type GitRunResult, runGit } from "./git-observer.ts";

const TIMEOUT_MS = 15_000;
const WORKTREES_SEGMENT = join(".apex-code", "worktrees");
const BRANCH_PREFIX = "apex-session-";

/**
 * A user-chosen name becomes both a path and a branch. The same allowlist the
 * child worktree owner uses for a session id, so `..` and a leading dash never
 * reach git.
 */
function isSafeName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..") && !name.endsWith(".lock");
}

function describeFailure(result: GitRunResult): string {
	if (result.spawnError) return "git could not be executed";
	if (result.timedOut) return "git timed out";
	const detail = result.stderr.trim().split("\n")[0] ?? "";
	return detail ? `git failed: ${detail}` : `git failed with exit code ${result.code ?? "unknown"}`;
}

export interface PreparedSessionWorktree {
	path: string;
	branch: string;
}

export interface ReleasedSessionWorktree {
	removed: boolean;
	kept?: "dirty" | "failed";
	path?: string;
	error?: string;
}

function worktreeDir(workspaceRoot: string, name: string): string {
	if (!isSafeName(name)) {
		throw new Error(`Worktree refused: name "${name}" is not a safe path component.`);
	}
	return join(workspaceRoot, WORKTREES_SEGMENT, name);
}

/**
 * Create `<workspaceRoot>/.apex-code/worktrees/<name>` on branch
 * `apex-session-<name>`. Throws outside a git repository, when git is missing,
 * or when the name is not a safe path component. The branch prefix is not the
 * child prefix `apex-child-`, so a user tree and a child tree do not share a
 * branch name.
 */
export async function prepareSessionWorktree(workspaceRoot: string, name: string): Promise<PreparedSessionWorktree> {
	const dir = worktreeDir(workspaceRoot, name);
	const probe = await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"], TIMEOUT_MS);
	if (!probe.ok) {
		throw new Error(
			`Worktree refused for "${name}": ${describeFailure(probe)}; worktree isolation requires a git repository.`,
		);
	}
	const toplevel = probe.stdout.toString("utf-8").trim();
	await keepWorktreesUntracked(workspaceRoot, toplevel);
	const branch = `${BRANCH_PREFIX}${name}`;
	const added = await runGit(workspaceRoot, ["worktree", "add", "-b", branch, dir], TIMEOUT_MS);
	if (!added.ok) {
		throw new Error(`Worktree failed for "${name}": ${describeFailure(added)}.`);
	}
	return { path: dir, branch };
}

/**
 * Remove the worktree when it is clean. Keep it when it has uncommitted or
 * untracked files, and return the path so the caller can print it. Never
 * force-removes and never merges.
 */
export async function releaseSessionWorktree(workspaceRoot: string, name: string): Promise<ReleasedSessionWorktree> {
	if (!isSafeName(name)) return { removed: true };
	const dir = worktreeDir(workspaceRoot, name);
	if (!existsSync(dir)) {
		await runGit(workspaceRoot, ["worktree", "prune"], TIMEOUT_MS);
		return { removed: true };
	}
	const removed = await runGit(workspaceRoot, ["worktree", "remove", dir], TIMEOUT_MS);
	if (removed.ok) return { removed: true };
	const status = await runGit(dir, ["status", "--porcelain"], TIMEOUT_MS);
	if (status.ok && status.stdout.toString("utf-8").trim() !== "") {
		return { removed: false, kept: "dirty", path: dir, error: describeFailure(removed) };
	}
	return { removed: false, kept: "failed", path: dir, error: describeFailure(removed) };
}

/**
 * The process `exit` event cannot await. This runs the same remove-or-keep
 * decision with a synchronous git call and returns the path when the tree stays.
 */
export function releaseSessionWorktreeSync(workspaceRoot: string, name: string): ReleasedSessionWorktree {
	if (!isSafeName(name)) return { removed: true };
	const dir = worktreeDir(workspaceRoot, name);
	if (!existsSync(dir)) return { removed: true };
	const removed = spawnSync("git", ["worktree", "remove", dir], { cwd: workspaceRoot, encoding: "utf-8" });
	if (removed.status === 0) return { removed: true };
	const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf-8" });
	if (status.status === 0 && status.stdout.trim() !== "") {
		return { removed: false, kept: "dirty", path: dir };
	}
	return { removed: false, kept: "failed", path: dir };
}

/** Same exclude entry the child owner writes, so the directory stays out of `git status`. */
async function keepWorktreesUntracked(workspaceRoot: string, toplevel: string): Promise<void> {
	const dir = join(workspaceRoot, WORKTREES_SEGMENT);
	const repoRelative = relative(toplevel, dir);
	if (repoRelative === "" || isAbsolute(repoRelative) || repoRelative.startsWith("..")) return;
	const entry = `${repoRelative.split(sep).join("/")}/`;
	try {
		const ignored = await runGit(toplevel, ["check-ignore", "-q", entry], TIMEOUT_MS);
		if (ignored.ok) return;
		const excludePathResult = await runGit(toplevel, ["rev-parse", "--git-path", "info/exclude"], TIMEOUT_MS);
		if (!excludePathResult.ok) return;
		const excludePath = resolve(toplevel, excludePathResult.stdout.toString("utf-8").trim());
		mkdirSync(dirname(excludePath), { recursive: true });
		const current = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
		if (current.split(/\r?\n/).includes(entry)) return;
		const needsNewLine = current.length > 0 && !current.endsWith("\n");
		writeFileSync(excludePath, `${needsNewLine ? "\n" : ""}${entry}\n`, { flag: "a", encoding: "utf-8" });
	} catch {
		// An unwritable exclude never fails the worktree.
	}
}
