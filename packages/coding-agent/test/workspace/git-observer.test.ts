import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeWorkspaceGit } from "../../src/core/workspace/git-observer.ts";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "apex-git-observer-"));
});

afterEach(() => {
	rmSync(scratch, { force: true, recursive: true });
});

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trimEnd();
}

function gitAllowFail(repo: string, ...args: string[]): { code: number; stdout: string } {
	try {
		return { code: 0, stdout: execFileSync("git", args, { cwd: repo, encoding: "utf-8" }) };
	} catch (error) {
		const err = error as { status?: number; stdout?: string };
		return { code: err.status ?? 1, stdout: err.stdout ?? "" };
	}
}

function commitAll(repo: string, message: string): void {
	git(repo, "add", "-A");
	git(repo, "-c", "user.name=observer", "-c", "user.email=observer@example.com", "commit", "-m", message);
}

function initRepo(name: string): string {
	const repo = join(scratch, name);
	execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf-8" });
	git(repo, "config", "user.email", "observer@example.com");
	git(repo, "config", "user.name", "observer");
	return repo;
}

function sha256Text(text: string): string {
	return `sha256:${createHash("sha256").update(text, "utf-8").digest("hex")}`;
}

/** Byte identity of every piece of repository state observation must not touch. */
function worktreeFingerprint(repo: string): string {
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === ".git" && dir === repo) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.push(full);
		}
	};
	walk(repo);
	files.sort();
	const parts = files.map((full) => {
		const rel = relative(repo, full);
		const stat = lstatSync(full);
		const content = stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full);
		return `${rel}:${createHash("sha256").update(content).digest("hex")}:${stat.mtimeMs}`;
	});
	return parts.join("\n");
}

function repoSnapshot(repo: string): string {
	return JSON.stringify([
		git(repo, "rev-parse", "HEAD"),
		git(repo, "branch", "--show-current"),
		gitAllowFail(repo, "stash", "list").stdout,
		git(repo, "config", "--local", "--list"),
		git(repo, "ls-files", "--stage"),
		git(repo, "status", "--porcelain", "--untracked-files=all", "--ignored=matching"),
		readFileSync(join(repo, ".git", "index")).toString("hex"),
		worktreeFingerprint(repo),
	]);
}

async function observe(repo: string, options?: Parameters<typeof observeWorkspaceGit>[1]) {
	return observeWorkspaceGit(repo, options);
}

describe("git observation adapter", () => {
	it("reports a clean repository as observed with full coverage", async () => {
		const repo = initRepo("clean");
		writeFileSync(join(repo, "tracked.txt"), "one\n");
		commitAll(repo, "initial");

		const record = await observe(repo);

		expect(record.status).toBe("observed");
		expect(record.backend).toBe("git");
		expect(record.workspaceRoot).toBe(repo);
		// Coverage records what the observation examined, not what changed.
		expect(record.coverage).toEqual({
			tracked: true,
			staged: true,
			unstaged: true,
			untracked: true,
			ignored: true,
			hashes: true,
			patch: false,
		});
		expect(record.paths).toEqual([]);
		expect(record.base?.headCommit).toBe(git(repo, "rev-parse", "HEAD"));
		expect(record.base?.branch).toBe("main");
		expect(record.base?.indexDigest).toMatch(/^sha256:/);
		expect(record.base?.worktreeDigest).toMatch(/^sha256:/);
		expect(record.warnings).toEqual([]);
	});

	it("reports staged, unstaged, untracked, ignored, and deleted paths separately", async () => {
		const repo = initRepo("mixed");
		writeFileSync(join(repo, "staged.txt"), "staged\n");
		writeFileSync(join(repo, "edited.txt"), "edited\n");
		writeFileSync(join(repo, "dropped.txt"), "dropped\n");
		commitAll(repo, "initial");

		writeFileSync(join(repo, "staged.txt"), "staged changed\n");
		git(repo, "add", "staged.txt");
		writeFileSync(join(repo, "edited.txt"), "edited more\n");
		rmSync(join(repo, "dropped.txt"));
		writeFileSync(join(repo, "fresh.txt"), "fresh\n");
		writeFileSync(join(repo, ".gitignore"), "*.log\n");
		writeFileSync(join(repo, "secret.log"), "ignored content\n");

		const record = await observe(repo);
		const byPath = new Map(record.paths.map((p) => [p.path, p]));

		expect(record.status).toBe("observed");
		const staged = byPath.get("staged.txt");
		expect(staged).toMatchObject({ kind: "modified", staged: true, unstaged: false });
		const edited = byPath.get("edited.txt");
		expect(edited).toMatchObject({ kind: "modified", staged: false, unstaged: true });
		const dropped = byPath.get("dropped.txt");
		expect(dropped).toMatchObject({ kind: "deleted", unstaged: true });
		expect(dropped?.contentHash).toBeUndefined();
		const fresh = byPath.get("fresh.txt");
		expect(fresh).toMatchObject({ kind: "untracked" });
		const ignoredLog = byPath.get("secret.log");
		expect(ignoredLog).toMatchObject({ kind: "untracked", ignored: true });
		expect(record.coverage.staged).toBe(true);
		expect(record.coverage.unstaged).toBe(true);
		expect(record.coverage.untracked).toBe(true);
		expect(record.coverage.ignored).toBe(true);
	});

	it("hashes present files with sha256 and skips deleted ones", async () => {
		const repo = initRepo("hashes");
		writeFileSync(join(repo, "a.txt"), "alpha\n");
		commitAll(repo, "initial");
		writeFileSync(join(repo, "a.txt"), "alpha changed\n");
		writeFileSync(join(repo, "gone.txt"), "bye\n");
		rmSync(join(repo, "gone.txt"));

		const record = await observe(repo);
		const a = record.paths.find((p) => p.path === "a.txt");
		expect(a?.contentHash).toBe(sha256Text("alpha changed\n"));
	});

	it("maps a staged rename to kind renamed with the previous path", async () => {
		const repo = initRepo("renamed");
		writeFileSync(join(repo, "old.txt"), "contents\n");
		commitAll(repo, "initial");
		git(repo, "mv", "old.txt", "new.txt");

		const record = await observe(repo);
		const renamed = record.paths.find((p) => p.path === "new.txt");
		expect(renamed).toMatchObject({ kind: "renamed", previousPath: "old.txt", staged: true });
	});

	it("reports detached HEAD with a warning and no branch", async () => {
		const repo = initRepo("detached");
		writeFileSync(join(repo, "a.txt"), "a\n");
		commitAll(repo, "initial");
		git(repo, "checkout", "--detach");

		const record = await observe(repo);
		expect(record.status).toBe("observed");
		expect(record.base?.branch).toBeUndefined();
		expect(record.base?.headCommit).toBe(git(repo, "rev-parse", "HEAD"));
		expect(record.warnings.join("\n")).toMatch(/detached/i);
	});

	it("reports merge conflicts as both staged and unstaged with a warning", async () => {
		const repo = initRepo("merge");
		writeFileSync(join(repo, "conflict.txt"), "base\n");
		commitAll(repo, "base");
		git(repo, "checkout", "-b", "feature");
		writeFileSync(join(repo, "conflict.txt"), "feature\n");
		commitAll(repo, "feature");
		git(repo, "checkout", "main");
		writeFileSync(join(repo, "conflict.txt"), "main\n");
		commitAll(repo, "main change");
		gitAllowFail(repo, "merge", "feature");

		const record = await observe(repo);
		const conflicted = record.paths.find((p) => p.path === "conflict.txt");
		expect(conflicted).toBeDefined();
		expect(conflicted?.staged).toBe(true);
		expect(conflicted?.unstaged).toBe(true);
		expect(record.warnings.join("\n")).toMatch(/unmerged|merge/i);
		expect(record.base?.headCommit).toBe(git(repo, "rev-parse", "HEAD"));
	});

	it("covers symlinks without following them", { skip: process.platform === "win32" }, async () => {
		const repo = initRepo("symlink");
		writeFileSync(join(repo, "target.txt"), "target bytes\n");
		commitAll(repo, "initial");
		execFileSync("ln", ["-s", "target.txt", join(repo, "link.txt")]);

		const record = await observe(repo);
		const link = record.paths.find((p) => p.path === "link.txt");
		expect(link).toMatchObject({ kind: "untracked" });
		expect(link?.contentHash).toBe(sha256Text("target.txt"));
	});

	it(
		"resolves a symlinked workspace root without mangling paths",
		{ skip: process.platform === "win32" },
		async () => {
			const real = initRepo("real-dir");
			writeFileSync(join(real, "tracked.txt"), "one\n");
			commitAll(real, "initial");
			writeFileSync(join(real, "tracked.txt"), "one changed\n");
			const alias = join(scratch, "alias");
			execFileSync("ln", ["-s", real, alias]);

			const record = await observe(alias);

			expect(record.status).toBe("observed");
			expect(record.workspaceRoot).toBe(alias);
			expect(record.paths.find((p) => p.path === "tracked.txt")).toMatchObject({ kind: "modified" });
		},
	);

	it("reports a supported submodule without recursing into it", async () => {
		const child = initRepo("submodule-child");
		writeFileSync(join(child, "inner.txt"), "inner\n");
		commitAll(child, "inner initial");

		const repo = initRepo("parent");
		writeFileSync(join(repo, "outer.txt"), "outer\n");
		commitAll(repo, "outer initial");
		git(repo, "-c", "protocol.file.allow=always", "submodule", "add", child, "child");
		commitAll(repo, "add submodule");
		// Advance the submodule clone past the recorded gitlink: the change
		// signal porcelain reports without recursing into the submodule
		// worktree. The clone needs its own identity to commit.
		const subClone = join(repo, "child");
		git(subClone, "config", "user.email", "observer@example.com");
		git(subClone, "config", "user.name", "observer");
		git(subClone, "commit", "--allow-empty", "-m", "advance");

		const record = await observe(repo);
		const sub = record.paths.find((p) => p.path === "child");
		expect(sub).toBeDefined();
		expect(record.status).toBe("observed");
		// No recursion: the submodule's own files are not reported.
		expect(record.paths.find((p) => p.path === "child/inner.txt")).toBeUndefined();
	});

	it("returns unsupported for a non-Git directory without scanning it", async () => {
		const dir = join(scratch, "plain");
		mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 500; i++) {
			writeFileSync(join(dir, `file-${i}.txt`), "x\n");
		}

		const record = await observe(dir);

		expect(record.status).toBe("unsupported");
		expect(record.backend).toBe("git");
		expect(record.paths).toEqual([]);
		expect(Object.values(record.coverage).every((v) => v === false)).toBe(true);
	});

	it("returns observed with an unborn-HEAD warning for a repository without commits", async () => {
		const repo = initRepo("unborn");
		writeFileSync(join(repo, "staged.txt"), "staged\n");
		git(repo, "add", "staged.txt");

		const record = await observe(repo);
		expect(record.status).toBe("observed");
		expect(record.base?.headCommit).toBeUndefined();
		expect(record.warnings.join("\n")).toMatch(/unborn|no commits/i);
		const staged = record.paths.find((p) => p.path === "staged.txt");
		expect(staged).toMatchObject({ staged: true, unstaged: false });
	});

	it("reports incomplete and keeps partial data when the path limit truncates", async () => {
		const repo = initRepo("truncate");
		writeFileSync(join(repo, "base.txt"), "base\n");
		commitAll(repo, "initial");
		for (const name of ["a", "b", "c"]) {
			writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
		}

		const record = await observe(repo, { maxPaths: 2 });

		expect(record.status).toBe("incomplete");
		expect(record.paths).toHaveLength(2);
		expect(record.base?.worktreeDigest).toBeUndefined();
		expect(record.base?.indexDigest).toBeDefined();
		expect(record.warnings.join("\n")).toMatch(/truncat/i);
	});

	it("reports failed for an already-cancelled signal", async () => {
		const repo = initRepo("cancelled");
		writeFileSync(join(repo, "a.txt"), "a\n");
		commitAll(repo, "initial");

		const controller = new AbortController();
		controller.abort();
		const record = await observe(repo, { signal: controller.signal });

		expect(record.status).toBe("failed");
		expect(record.warnings.join("\n")).toMatch(/cancel/i);
	});

	it("reports incomplete when hashing skips a file over the byte cap", async () => {
		const repo = initRepo("oversized");
		writeFileSync(join(repo, "a.txt"), "a\n");
		commitAll(repo, "initial");
		writeFileSync(join(repo, "big.txt"), "x".repeat(16));

		const record = await observe(repo, { maxHashBytes: 8 });
		expect(record.status).toBe("incomplete");
		expect(record.warnings.join("\n")).toMatch(/hash|skip/i);
		const big = record.paths.find((p) => p.path === "big.txt");
		expect(big).toBeDefined();
		expect(big?.contentHash).toBeUndefined();
	});

	it("omits hashes when hashPaths is disabled while staying observed", async () => {
		const repo = initRepo("nohash");
		writeFileSync(join(repo, "a.txt"), "a\n");
		commitAll(repo, "initial");
		writeFileSync(join(repo, "b.txt"), "b\n");

		const record = await observe(repo, { hashPaths: false });

		expect(record.status).toBe("observed");
		expect(record.coverage.hashes).toBe(false);
		expect(record.paths.every((p) => p.contentHash === undefined)).toBe(true);
	});

	it("keeps the worktree digest stable when nothing changes and moves with edits", async () => {
		const repo = initRepo("digests");
		writeFileSync(join(repo, "a.txt"), "a\n");
		commitAll(repo, "initial");

		const first = await observe(repo);
		const second = await observe(repo);
		expect(first.base?.worktreeDigest).toBe(second.base?.worktreeDigest);
		expect(first.base?.indexDigest).toBe(second.base?.indexDigest);

		writeFileSync(join(repo, "a.txt"), "changed\n");
		const third = await observe(repo);
		expect(third.base?.worktreeDigest).not.toBe(first.base?.worktreeDigest);
		// The index baseline does not move for a worktree-only edit.
		expect(third.base?.indexDigest).toBe(first.base?.indexDigest);

		git(repo, "add", "a.txt");
		const fourth = await observe(repo);
		expect(fourth.base?.indexDigest).not.toBe(first.base?.indexDigest);
	});

	it("leaves repository state byte-identical outside its returned metadata", async () => {
		const repo = initRepo("readonly");
		writeFileSync(join(repo, "tracked.txt"), "one\n");
		commitAll(repo, "initial");
		writeFileSync(join(repo, "tracked.txt"), "one changed\n");
		writeFileSync(join(repo, "staged.txt"), "staged\n");
		git(repo, "add", "staged.txt");
		writeFileSync(join(repo, "untracked.txt"), "untracked\n");
		writeFileSync(join(repo, ".gitignore"), "*.log\n");
		writeFileSync(join(repo, "debug.log"), "ignored\n");

		const before = repoSnapshot(repo);
		const record = await observe(repo);
		const after = repoSnapshot(repo);

		expect(record.status).toBe("observed");
		expect(after).toBe(before);
	}, 20_000);
});
