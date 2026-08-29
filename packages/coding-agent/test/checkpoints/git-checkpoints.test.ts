import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitCheckpoints } from "../../src/core/checkpoints/git-checkpoints.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** A repository with one commit, a tracked file, and a `.gitignore` that hides `ignored`. */
function repository(): string {
	const cwd = temporaryDirectory("apex-checkpoints-");
	git(cwd, "init", "-q", ".");
	git(cwd, "config", "user.email", "fixture@example.com");
	git(cwd, "config", "user.name", "fixture");
	writeFileSync(join(cwd, "tracked.txt"), "v1\n");
	writeFileSync(join(cwd, ".gitignore"), "ignored\n");
	git(cwd, "add", "-A");
	git(cwd, "commit", "-qm", "base");
	return cwd;
}

/** Every ref the engine owns, so a test can assert that an unconfigured path writes none. */
function checkpointRefs(cwd: string): string[] {
	return git(cwd, "for-each-ref", "--format=%(refname)", "refs/apex-code/").split("\n").filter(Boolean);
}

describe("git checkpoints", () => {
	it("returns undefined outside a git repository", async () => {
		const cwd = temporaryDirectory("apex-checkpoints-nogit-");
		expect(await createGitCheckpoints(cwd, "session")).toBeUndefined();
	});

	it("captures a repository that has no commits yet", async () => {
		const cwd = temporaryDirectory("apex-checkpoints-empty-");
		git(cwd, "init", "-q", ".");
		writeFileSync(join(cwd, "first.txt"), "hello\n");

		const checkpoints = await createGitCheckpoints(cwd, "session");
		const captured = await checkpoints?.capture("entry-1");

		// `commit-tree -p HEAD` cannot work before the first commit, so the engine must
		// omit the parent rather than fail the capture.
		expect(captured?.commit).toMatch(/^[0-9a-f]{40}$/);
	});

	it("leaves the index, worktree, HEAD, and stash untouched by a capture", async () => {
		const cwd = repository();
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");
		writeFileSync(join(cwd, "untracked.txt"), "new\n");

		const statusBefore = git(cwd, "status", "--porcelain");
		const headBefore = git(cwd, "rev-parse", "HEAD");

		const checkpoints = await createGitCheckpoints(cwd, "session");
		await checkpoints?.capture("entry-1");

		expect(git(cwd, "status", "--porcelain")).toBe(statusBefore);
		expect(git(cwd, "rev-parse", "HEAD")).toBe(headBefore);
		expect(git(cwd, "stash", "list")).toBe("");
	});

	it("captures untracked files and excludes gitignored ones", async () => {
		const cwd = repository();
		writeFileSync(join(cwd, "untracked.txt"), "new\n");
		writeFileSync(join(cwd, "ignored"), "secret\n");

		const checkpoints = await createGitCheckpoints(cwd, "session");
		const captured = await checkpoints?.capture("entry-1");
		const files = git(cwd, "ls-tree", "-r", "--name-only", captured?.commit ?? "").split("\n");

		expect(files).toContain("untracked.txt");
		expect(files).not.toContain("ignored");
	});

	it("survives aggressive garbage collection", async () => {
		const cwd = repository();
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");

		const checkpoints = await createGitCheckpoints(cwd, "session");
		const captured = await checkpoints?.capture("entry-1");

		// The defect this whole engine exists to fix: `git stash create` leaves the commit
		// unreachable, so gc reaps it and the restore fails after the user has already
		// agreed to it. A ref makes it reachable.
		git(cwd, "gc", "--prune=now", "--aggressive");

		expect(git(cwd, "cat-file", "-t", captured?.commit ?? "")).toBe("commit");
	});

	it("resolves a checkpoint captured by an earlier instance", async () => {
		const cwd = repository();
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");

		const first = await createGitCheckpoints(cwd, "session");
		const captured = await first?.capture("entry-1");

		// A second instance built from nothing but the workspace path stands in for a
		// restart: the registry is git, so no Apex-side state has to survive.
		const second = await createGitCheckpoints(cwd, "session");

		expect((await second?.lookup("entry-1"))?.commit).toBe(captured?.commit);
	});

	it("restores the worktree exactly, including files deleted since the checkpoint", async () => {
		const cwd = repository();
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");
		writeFileSync(join(cwd, "untracked.txt"), "new\n");
		const statusAtCapture = git(cwd, "status", "--porcelain");

		const checkpoints = await createGitCheckpoints(cwd, "session");
		const captured = await checkpoints?.capture("entry-1");

		writeFileSync(join(cwd, "tracked.txt"), "v3\n");
		writeFileSync(join(cwd, "created-after.txt"), "later\n");
		rmSync(join(cwd, "untracked.txt"));

		await checkpoints?.restore(captured!);

		expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe("v2\n");
		expect(readFileSync(join(cwd, "untracked.txt"), "utf8")).toBe("new\n");
		expect(existsSync(join(cwd, "created-after.txt"))).toBe(false);
		expect(git(cwd, "status", "--porcelain")).toBe(statusAtCapture);
	});

	it("leaves gitignored files and HEAD alone during a restore", async () => {
		const cwd = repository();
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");
		const headBefore = git(cwd, "rev-parse", "HEAD");

		const checkpoints = await createGitCheckpoints(cwd, "session");
		const captured = await checkpoints?.capture("entry-1");

		writeFileSync(join(cwd, "tracked.txt"), "v3\n");
		writeFileSync(join(cwd, "ignored"), "build output\n");

		await checkpoints?.restore(captured!);

		expect(readFileSync(join(cwd, "ignored"), "utf8")).toBe("build output\n");
		expect(git(cwd, "rev-parse", "HEAD")).toBe(headBefore);
	});

	it("makes a restore reversible through the checkpoint it returns", async () => {
		const cwd = repository();
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");

		const checkpoints = await createGitCheckpoints(cwd, "session");
		const captured = await checkpoints?.capture("entry-1");

		writeFileSync(join(cwd, "tracked.txt"), "v3\n");
		writeFileSync(join(cwd, "created-after.txt"), "later\n");

		const previous = await checkpoints?.restore(captured!);
		expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe("v2\n");

		await checkpoints?.restore(previous!);

		expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe("v3\n");
		expect(readFileSync(join(cwd, "created-after.txt"), "utf8")).toBe("later\n");
	});

	it("commits with a fixed identity in a repository that configures none", async () => {
		const cwd = temporaryDirectory("apex-checkpoints-noidentity-");
		git(cwd, "init", "-q", ".");
		writeFileSync(join(cwd, "a.txt"), "hi\n");

		const checkpoints = await createGitCheckpoints(cwd, "session");
		const captured = await checkpoints?.capture("entry-1");

		// Without a forced identity this repository cannot commit at all, so a capture
		// that depended on user config would fail exactly where a fresh clone lives.
		expect(git(cwd, "show", "-s", "--format=%an", captured?.commit ?? "")).toBe("apex-code");
	});

	it("bounds the ref namespace to maxPerSession, oldest first", async () => {
		const cwd = repository();
		const checkpoints = await createGitCheckpoints(cwd, "session", { maxPerSession: 2 });

		for (const entryId of ["entry-1", "entry-2", "entry-3"]) {
			writeFileSync(join(cwd, "tracked.txt"), `${entryId}\n`);
			await checkpoints?.capture(entryId);
		}

		expect(await checkpoints?.lookup("entry-1")).toBeUndefined();
		expect((await checkpoints?.list())?.map((checkpoint) => checkpoint.entryId)).toEqual(["entry-2", "entry-3"]);
	});

	it("keeps one session's refs out of another's", async () => {
		const cwd = repository();
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");

		const mine = await createGitCheckpoints(cwd, "session-a");
		const theirs = await createGitCheckpoints(cwd, "session-b");
		await mine?.capture("entry-1");
		await theirs?.capture("entry-1");

		await mine?.prune();

		expect(await mine?.lookup("entry-1")).toBeUndefined();
		expect(await theirs?.lookup("entry-1")).toBeDefined();
	});

	it("round-trips bytes exactly when the machine sets core.autocrlf", async () => {
		const cwd = repository();
		// What every Windows checkout configures by default. It is a preference of the
		// machine, not of the repository, and it must not decide what a checkpoint restores:
		// left on, capture and restore run the worktree through git's clean/smudge filters
		// and an agent-written LF file comes back CRLF.
		git(cwd, "config", "core.autocrlf", "true");
		writeFileSync(join(cwd, "lf.txt"), "one\ntwo\n");
		writeFileSync(join(cwd, "crlf.txt"), "one\r\ntwo\r\n");

		const checkpoints = await createGitCheckpoints(cwd, "session");
		const captured = await checkpoints?.capture("entry-1");

		writeFileSync(join(cwd, "lf.txt"), "changed\n");
		writeFileSync(join(cwd, "crlf.txt"), "changed\r\n");
		await checkpoints?.restore(captured!);

		expect(readFileSync(join(cwd, "lf.txt"), "utf8")).toBe("one\ntwo\n");
		expect(readFileSync(join(cwd, "crlf.txt"), "utf8")).toBe("one\r\ntwo\r\n");
	});

	it("refuses an entry id that is not a safe ref component", async () => {
		const cwd = repository();
		const checkpoints = await createGitCheckpoints(cwd, "session");

		// An entry id reaches the engine from a session file, so a crafted one must not be
		// able to name a ref outside the engine's own namespace.
		expect(await checkpoints?.capture("../../heads/main")).toBeUndefined();
		expect(checkpointRefs(cwd)).toEqual([]);
	});

	it("writes no ref when nothing captures", async () => {
		const cwd = repository();
		await createGitCheckpoints(cwd, "session");

		expect(checkpointRefs(cwd)).toEqual([]);
	});
});
