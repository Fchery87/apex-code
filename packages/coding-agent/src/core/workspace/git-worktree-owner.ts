import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ChildWorkspaceRequest, WorkspaceReleaseOutcome } from "../delegation/runtime.ts";
import { type GitRunResult, runGit } from "./git-observer.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
/** Fixed location beneath the workspace root, so a child's checkout is always findable and always inside the workspace. */
const WORKTREES_SEGMENT = join(".apex-code", "worktrees");
const BRANCH_PREFIX = "apex-child-";
/**
 * Short branch ids keep `git branch` output readable. Eight hex characters of a
 * UUID still bound prefix collisions between concurrent children to ~2^-32 per
 * pair; the branch ref (not the checkout) is the durable artifact anyway.
 */
const SHORT_SESSION_ID_LENGTH = 8;

/**
 * A session id names both a filesystem path and a branch here, so it must be a
 * single safe component. A caller-supplied delegation handle flows in as the
 * session id, and `../../` or a leading `-` must never become a path traversal
 * or an option injection. Same allowlist shape the checkpoint engine uses for
 * ref components.
 */
function isSafeSessionId(sessionId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) && !sessionId.includes("..") && !sessionId.endsWith(".lock");
}

function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, SHORT_SESSION_ID_LENGTH);
}

/** One-line human explanation of a failed git run, for refusal and failure errors. */
function describeFailure(result: GitRunResult): string {
	if (result.spawnError) return "git could not be executed";
	if (result.timedOut) return "git timed out";
	const detail = result.stderr.trim().split("\n")[0] ?? "";
	return detail ? `git failed: ${detail}` : `git failed with exit code ${result.code ?? "unknown"}`;
}

export interface GitWorktreeWorkspaceOwnerOptions {
	/** Per-command timeout in milliseconds (default 15 000). */
	timeoutMs?: number;
}

/**
 * The production workspace owner for worktree isolation (spec
 * 2026-09-09-run-and-child-session-architecture.md, "Parallel work and
 * ownership"). The workspace subsystem owns git; delegation stays git-free:
 * `prepare()` creates one linked worktree per child at
 * `<workspaceRoot>/.apex-code/worktrees/<sessionId>` on branch
 * `apex-child-<short-sessionId>` and returns the request with `root` set, which
 * is how the child session's cwd ends up inside the worktree. `release()`
 * removes it again. Refusals are throws: outside a git repository (or without
 * a git executable) `prepare()` throws, and the delegation runtime surfaces
 * that throw as the delegation's failure.
 *
 * Cleanup choices, deliberately:
 * - `git worktree remove` runs without `--force` and there is no automatic
 *   fallback. When the plain remove refuses -- typically a dirty tree, since a
 *   child that wrote files leaves untracked content behind -- the tree is
 *   inspected and *kept*, reported as a `kept: "dirty"` release outcome so
 *   uncommitted child work is preserved. Only an explicit
 *   `release(id, { force: true })` from the caller force-removes. The child's
 *   branch ref survives either way, so the parent can still integrate through
 *   an explicit git workflow, and this owner never merges, commits, or pushes
 *   anything.
 * - A worktree that is already gone is tolerated, so releasing twice, or
 *   releasing a failed delegation whose `prepare()` died before creating
 *   anything, are both no-ops.
 * - The worktrees directory is kept out of the parent checkout's `git status`
 *   through the repository-local `.git/info/exclude` -- the one ignore channel
 *   that cannot touch tracked project files such as `.gitignore` (which the
 *   spec forbids the coordinator from editing). Left unignored, the linked
 *   worktrees would report as untracked churn and spuriously retire
 *   verification results. Best effort only: a failure here never fails the
 *   worktree itself.
 */
export class GitWorktreeWorkspaceOwner {
	private readonly workspaceRoot: string;
	private readonly timeoutMs: number;

	constructor(workspaceRoot: string, options?: GitWorktreeWorkspaceOwnerOptions) {
		this.workspaceRoot = workspaceRoot;
		this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** The worktree directory this owner uses for one child session. */
	private worktreeDir(sessionId: string): string {
		if (!isSafeSessionId(sessionId)) {
			throw new Error(`Worktree isolation refused: session id "${sessionId}" is not a safe path component.`);
		}
		return join(this.workspaceRoot, WORKTREES_SEGMENT, sessionId);
	}

	/**
	 * Create the child's worktree and return the request with `root` set to its
	 * path. Throws (refusing the delegation) when the workspace is not a git
	 * repository, git is unavailable, or the worktree cannot be created.
	 */
	async prepare(
		request: ChildWorkspaceRequest & { sessionId: string },
	): Promise<ChildWorkspaceRequest & { root: string }> {
		const dir = this.worktreeDir(request.sessionId);
		const toplevel = await this.requireRepository(request.sessionId);
		await this.keepWorktreesUntracked(toplevel);
		const branch = `${BRANCH_PREFIX}${shortSessionId(request.sessionId)}`;
		const added = await runGit(this.workspaceRoot, ["worktree", "add", "-b", branch, dir], this.timeoutMs);
		if (!added.ok) {
			throw new Error(`Worktree isolation failed for session "${request.sessionId}": ${describeFailure(added)}.`);
		}
		return { ...request, root: dir };
	}

	/**
	 * Remove the child's worktree safely. Plain `git worktree remove` first; if
	 * it refuses, the tree's status decides the outcome: uncommitted or
	 * untracked content means the tree is kept ("dirty") so child work is
	 * never destroyed silently; a clean tree that still cannot be removed is
	 * reported as "failed". `--force` runs only when the caller passes
	 * `options.force` -- the explicit escape hatch, never an automatic
	 * fallback. Already-removed worktrees are tolerated and never throw.
	 */
	async release(sessionId: string, options?: { force?: boolean }): Promise<WorkspaceReleaseOutcome> {
		if (!isSafeSessionId(sessionId)) return { removed: true }; // an unsafe id can never have been prepared
		const dir = this.worktreeDir(sessionId);
		if (!existsSync(dir)) {
			// Never created, already removed, or removed out of band: drop any
			// stale administrative entry and succeed either way.
			await runGit(this.workspaceRoot, ["worktree", "prune"], this.timeoutMs);
			return { removed: true };
		}
		if (options?.force) {
			const forced = await runGit(this.workspaceRoot, ["worktree", "remove", "--force", dir], this.timeoutMs);
			if (forced.ok) return { removed: true };
			return { removed: false, kept: "failed", dir, error: describeFailure(forced) };
		}
		const removed = await runGit(this.workspaceRoot, ["worktree", "remove", dir], this.timeoutMs);
		if (removed.ok) return { removed: true };
		// The plain remove refused. Inspect the tree: uncommitted/untracked
		// content means the refusal is protective and the tree stays.
		const status = await runGit(dir, ["status", "--porcelain"], this.timeoutMs);
		if (status.ok && status.stdout.toString("utf-8").trim() !== "") {
			return { removed: false, kept: "dirty", dir, error: describeFailure(removed) };
		}
		return { removed: false, kept: "failed", dir, error: describeFailure(removed) };
	}

	/**
	 * Read-only verification for explicit workspace recovery (spec
	 * 2026-09-09-run-and-child-session-architecture.md, "Workspace states and
	 * explicit recovery"): confirm `root` is still THIS owner's worktree for
	 * `sessionId` in the CURRENT workspace. Three checks, each refusal naming
	 * the check: (layout) the recorded path is exactly the owner's
	 * `<workspaceRoot>/.apex-code/worktrees/<sessionId>` and exists;
	 * (admin entry) `<root>/.git` is a linked-worktree pointer file whose gitdir
	 * resolves into the current repository's `.git/worktrees`; (branch) the
	 * checked-out branch is `apex-child-<short-sessionId>`. Never creates,
	 * checks out, resets, or force-removes anything -- git inspection is
	 * read-only (`rev-parse`, `status`) plus the administrative entry read.
	 * Returns the worktree's dirty state so callers can report preserved
	 * uncommitted work without a second inspection.
	 */
	async verify(sessionId: string, root: string): Promise<{ dirty: boolean }> {
		if (!isSafeSessionId(sessionId)) {
			throw new Error(`layout check failed: session id "${sessionId}" is not a safe path component.`);
		}
		// (c) The directory sits at this owner's layout for the session.
		const expected = this.worktreeDir(sessionId);
		if (resolve(root) !== expected) {
			throw new Error(
				`layout check failed: recorded root "${root}" is not this workspace's worktree location for session "${sessionId}" (expected "${expected}").`,
			);
		}
		if (!existsSync(root)) {
			throw new Error(`layout check failed: the recorded worktree root "${root}" does not exist.`);
		}
		// (a) The directory is a linked worktree of the CURRENT parent workspace:
		// its administrative entry resolves into this repository's worktrees dir.
		const pointerPath = join(root, ".git");
		let gitdirRaw: string;
		try {
			const content = readFileSync(pointerPath, "utf-8").trim();
			const match = /^gitdir:\s*(.+)$/.exec(content);
			if (!match) throw new Error('not a "gitdir:" pointer');
			gitdirRaw = match[1]!.trim();
		} catch (error) {
			throw new Error(
				`admin entry check failed: "${pointerPath}" is not a linked-worktree git pointer (${error instanceof Error ? error.message : String(error)}).`,
			);
		}
		const gitdir = resolve(root, gitdirRaw);
		const parentGitDir = await this.currentGitDir();
		const worktreesDir = join(parentGitDir, "worktrees");
		const rel = relative(worktreesDir, gitdir);
		if (rel === "" || isAbsolute(rel) || rel.startsWith("..") || !existsSync(gitdir)) {
			throw new Error(
				`admin entry check failed: "${root}" is not a linked worktree of the current repository (its gitdir "${gitdir}" does not resolve into "${worktreesDir}").`,
			);
		}
		// (b) The checked-out branch is this child's own.
		const branch = `${BRANCH_PREFIX}${shortSessionId(sessionId)}`;
		const head = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"], this.timeoutMs);
		const checkedOut = head.ok ? head.stdout.toString("utf-8").trim() : "";
		if (!head.ok || checkedOut !== branch) {
			throw new Error(
				`branch check failed: the worktree for session "${sessionId}" has ${
					head.ok ? `"${checkedOut}" checked out` : describeFailure(head)
				}, expected "${branch}".`,
			);
		}
		// The dirty report is informational, not a gate: uncommitted child work is
		// exactly what recovery must preserve, never destroy.
		const status = await runGit(root, ["status", "--porcelain"], this.timeoutMs);
		if (!status.ok) {
			throw new Error(`status check failed: the worktree's status could not be read: ${describeFailure(status)}.`);
		}
		return { dirty: status.stdout.toString("utf-8").trim() !== "" };
	}

	/** The current workspace repository's absolute git dir, for admin-entry verification. */
	private async currentGitDir(): Promise<string> {
		const probe = await runGit(this.workspaceRoot, ["rev-parse", "--absolute-git-dir"], this.timeoutMs);
		if (!probe.ok) {
			throw new Error(
				`admin entry check failed: the current workspace is not a readable git repository (${describeFailure(probe)}).`,
			);
		}
		return resolve(this.workspaceRoot, probe.stdout.toString("utf-8").trim());
	}

	/** Verify git is usable and the workspace sits inside a repository; returns the repository toplevel. */
	private async requireRepository(sessionId: string): Promise<string> {
		const probe = await runGit(this.workspaceRoot, ["rev-parse", "--show-toplevel"], this.timeoutMs);
		if (!probe.ok) {
			throw new Error(
				`Worktree isolation refused for session "${sessionId}": ${describeFailure(probe)}; worktree isolation requires a git repository.`,
			);
		}
		return probe.stdout.toString("utf-8").trim();
	}

	/**
	 * Keep `<...>/.apex-code/worktrees/` out of the parent checkout's status
	 * via `.git/info/exclude` (idempotent; forward-slash pattern as git
	 * requires, repo-relative so it also holds when the workspace root is a
	 * subdirectory of the repository).
	 */
	private async keepWorktreesUntracked(toplevel: string): Promise<void> {
		const dir = join(this.workspaceRoot, WORKTREES_SEGMENT);
		const repoRelative = relative(toplevel, dir);
		if (repoRelative === "" || isAbsolute(repoRelative) || repoRelative.startsWith("..")) return;
		const entry = `${repoRelative.split(sep).join("/")}/`;
		try {
			const ignored = await runGit(toplevel, ["check-ignore", "-q", entry], this.timeoutMs);
			if (ignored.ok) return;
			const excludePathResult = await runGit(toplevel, ["rev-parse", "--git-path", "info/exclude"], this.timeoutMs);
			if (!excludePathResult.ok) return;
			const excludePath = resolve(toplevel, excludePathResult.stdout.toString("utf-8").trim());
			mkdirSync(dirname(excludePath), { recursive: true });
			const current = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
			if (current.split(/\r?\n/).includes(entry)) return;
			const needsNewLine = current.length > 0 && !current.endsWith("\n");
			writeFileSync(excludePath, `${needsNewLine ? "\n" : ""}${entry}\n`, { flag: "a", encoding: "utf-8" });
		} catch {
			// Hygiene only: an unwritable or unreadable exclude never fails the worktree.
		}
	}
}
