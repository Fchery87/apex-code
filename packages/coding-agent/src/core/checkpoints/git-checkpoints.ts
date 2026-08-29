import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One captured worktree state, reachable from a ref so garbage collection cannot reap it. */
export interface GitCheckpoint {
	readonly entryId: string;
	readonly commit: string;
}

export interface GitCheckpointsOptions {
	/** Oldest refs beyond this count are deleted on capture. */
	readonly maxPerSession?: number;
	/** A capture that exceeds this is abandoned rather than allowed to stall a turn. */
	readonly timeoutMilliseconds?: number;
}

export interface GitCheckpoints {
	capture(entryId: string): Promise<GitCheckpoint | undefined>;
	lookup(entryId: string): Promise<GitCheckpoint | undefined>;
	list(): Promise<readonly GitCheckpoint[]>;
	/** Returns a checkpoint of the pre-restore state, which restores back through this same call. */
	restore(checkpoint: GitCheckpoint): Promise<GitCheckpoint | undefined>;
	/** Deletes every ref this session owns, leaving other sessions' refs alone. */
	prune(): Promise<void>;
}

const DEFAULT_MAX_PER_SESSION = 50;
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;

/**
 * A fixed identity, never the user's.
 *
 * A checkpoint is harness bookkeeping rather than authorship, and `commit-tree` fails
 * outright when no identity resolves. Depending on the user's config would break exactly
 * where it matters most: a fresh clone, and a CI checkout, both of which configure none.
 */
const CHECKPOINT_IDENTITY = {
	GIT_AUTHOR_NAME: "apex-code",
	GIT_AUTHOR_EMAIL: "checkpoints@apex-code.local",
	GIT_COMMITTER_NAME: "apex-code",
	GIT_COMMITTER_EMAIL: "checkpoints@apex-code.local",
} as const;

const SUBJECT_PREFIX = "apex-code checkpoint";

interface GitResult {
	readonly stdout: string;
	readonly ok: boolean;
}

async function runGit(
	cwd: string,
	args: string[],
	environment?: NodeJS.ProcessEnv,
	timeout?: number,
): Promise<GitResult> {
	return new Promise((resolve) => {
		const child = spawn("git", args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...environment },
		});
		let stdout = "";
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout: stdout.trim(), ok });
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(false);
		}, timeout ?? DEFAULT_TIMEOUT_MILLISECONDS);

		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.resume();
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
	});
}

/**
 * An entry id reaches this engine from a session file on disk, so it decides a ref name
 * that must not be able to escape the engine's own namespace. An allowlist is the check
 * that stays correct as git's own ref rules grow; a denylist of `..` and friends does not.
 */
function isSafeRefComponent(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..") && !value.endsWith(".lock");
}

export async function createGitCheckpoints(
	workspace: string,
	sessionId: string,
	options?: GitCheckpointsOptions,
): Promise<GitCheckpoints | undefined> {
	if (!isSafeRefComponent(sessionId)) return undefined;
	if (!(await runGit(workspace, ["rev-parse", "--git-dir"])).ok) return undefined;

	const maxPerSession = Math.max(1, options?.maxPerSession ?? DEFAULT_MAX_PER_SESSION);
	const timeout = options?.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
	const checkpointRef = (entryId: string) => `refs/apex-code/checkpoints/${sessionId}/${entryId}`;
	const preRestoreNamespace = `refs/apex-code/pre-restore/${sessionId}`;

	/**
	 * Write the worktree to a commit without touching anything the user can see.
	 *
	 * A private index is what makes that true: `add -A` against it stages tracked
	 * modifications and untracked files, honours `.gitignore`, and leaves the real index
	 * and the worktree byte-identical. `commit-tree` and `update-ref` are plumbing, so no
	 * hook runs and the stash is never involved.
	 */
	async function snapshot(subject: string): Promise<string | undefined> {
		const indexDirectory = await mkdtemp(join(tmpdir(), "apex-checkpoint-index-"));
		const indexFile = join(indexDirectory, "index");
		const environment = { GIT_INDEX_FILE: indexFile };
		try {
			// Fails before the first commit, which is a supported state rather than an error.
			await runGit(workspace, ["read-tree", "HEAD"], environment, timeout);
			if (!(await runGit(workspace, ["add", "-A"], environment, timeout)).ok) return undefined;

			const tree = await runGit(workspace, ["write-tree"], environment, timeout);
			if (!tree.ok) return undefined;

			const head = await runGit(workspace, ["rev-parse", "HEAD"]);
			const parent = head.ok ? ["-p", head.stdout] : [];
			const commit = await runGit(
				workspace,
				["commit-tree", tree.stdout, ...parent, "-m", subject],
				{ ...CHECKPOINT_IDENTITY, ...environment },
				timeout,
			);
			return commit.ok ? commit.stdout : undefined;
		} finally {
			await rm(indexDirectory, { force: true, recursive: true });
		}
	}

	async function refsUnder(namespace: string): Promise<Array<{ ref: string; commit: string; ordinal: number }>> {
		const listed = await runGit(workspace, [
			"for-each-ref",
			"--format=%(refname) %(objectname) %(contents:subject)",
			namespace,
		]);
		if (!listed.ok || listed.stdout === "") return [];
		return listed.stdout
			.split("\n")
			.map((line) => {
				const [ref, commit, ...subject] = line.split(" ");
				return { ref: ref ?? "", commit: commit ?? "", ordinal: Number(subject.at(-1)) };
			})
			.filter((entry) => entry.ref !== "" && Number.isFinite(entry.ordinal))
			.sort((left, right) => left.ordinal - right.ordinal);
	}

	/**
	 * Refs carry no creation order of their own, and `commit-tree` records a committer date
	 * only to the second, so two captures inside one second would be indistinguishable.
	 * The ordinal in the subject is the ordering, and it is derived from what is already on
	 * disk so it survives a restart the same way the refs do.
	 */
	async function nextOrdinal(): Promise<number> {
		const existing = [
			...(await refsUnder(`refs/apex-code/checkpoints/${sessionId}`)),
			...(await refsUnder(preRestoreNamespace)),
		];
		return (existing.at(-1)?.ordinal ?? 0) + 1;
	}

	async function bound(namespace: string): Promise<void> {
		const existing = await refsUnder(namespace);
		for (const stale of existing.slice(0, Math.max(0, existing.length - maxPerSession))) {
			await runGit(workspace, ["update-ref", "-d", stale.ref]);
		}
	}

	async function restoreCommit(commit: string): Promise<boolean> {
		const indexDirectory = await mkdtemp(join(tmpdir(), "apex-checkpoint-restore-"));
		const indexFile = join(indexDirectory, "index");
		const environment = { GIT_INDEX_FILE: indexFile };
		try {
			// Seeding the private index from the *current* worktree is what lets
			// `read-tree -u` remove files created after the checkpoint. Seeded from HEAD
			// instead, those files would be untracked and would survive the restore, which
			// is the merge-not-restore defect this replaces.
			await runGit(workspace, ["read-tree", "HEAD"], environment, timeout);
			await runGit(workspace, ["add", "-A"], environment, timeout);
			if (!(await runGit(workspace, ["read-tree", "-u", "--reset", commit], environment, timeout)).ok) return false;

			// The real index goes back to HEAD without touching the worktree, so the
			// checkpoint's changes read as unstaged, which is the shape they had at capture.
			await runGit(workspace, ["read-tree", "HEAD"], undefined, timeout);
			return true;
		} finally {
			await rm(indexDirectory, { force: true, recursive: true });
		}
	}

	return {
		async capture(entryId) {
			if (!isSafeRefComponent(entryId)) return undefined;
			const ordinal = await nextOrdinal();
			const commit = await snapshot(`${SUBJECT_PREFIX} ${ordinal}`);
			if (!commit) return undefined;
			if (!(await runGit(workspace, ["update-ref", checkpointRef(entryId), commit])).ok) return undefined;
			await bound(`refs/apex-code/checkpoints/${sessionId}`);
			return { entryId, commit };
		},

		async lookup(entryId) {
			if (!isSafeRefComponent(entryId)) return undefined;
			const resolved = await runGit(workspace, [
				"rev-parse",
				"--verify",
				"--quiet",
				`${checkpointRef(entryId)}^{commit}`,
			]);
			return resolved.ok && resolved.stdout !== "" ? { entryId, commit: resolved.stdout } : undefined;
		},

		async list() {
			const prefix = `refs/apex-code/checkpoints/${sessionId}/`;
			return (await refsUnder(`refs/apex-code/checkpoints/${sessionId}`)).map((entry) => ({
				entryId: entry.ref.slice(prefix.length),
				commit: entry.commit,
			}));
		},

		async restore(checkpoint) {
			const ordinal = await nextOrdinal();
			const previous = await snapshot(`${SUBJECT_PREFIX} ${ordinal}`);
			if (!previous) return undefined;
			// Pinned before the restore runs, so an interrupted restore still leaves the
			// pre-restore state reachable rather than orphaned.
			await runGit(workspace, ["update-ref", `${preRestoreNamespace}/${ordinal}`, previous]);
			await bound(preRestoreNamespace);
			if (!(await restoreCommit(checkpoint.commit))) return undefined;
			return { entryId: "pre-restore", commit: previous };
		},

		async prune() {
			for (const namespace of [`refs/apex-code/checkpoints/${sessionId}`, preRestoreNamespace]) {
				for (const entry of await refsUnder(namespace)) {
					await runGit(workspace, ["update-ref", "-d", entry.ref]);
				}
			}
		},
	};
}

/**
 * Opt-in configuration for the engine above.
 *
 * Absent by default, and an absent key constructs no engine, so an unconfigured session
 * runs no `git` subprocess and writes no ref.
 */
export interface CheckpointSettings {
	enabled?: boolean;
	/** Oldest refs beyond this count are deleted on capture. Defaults to 50. */
	maxPerSession?: number;
}
