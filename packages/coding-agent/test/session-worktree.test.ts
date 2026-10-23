import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reportConcurrentSessionRefusal } from "../src/cli/concurrent-session.ts";
import type { SessionLease } from "../src/core/session-lease.ts";
import { prepareSessionWorktree, releaseSessionWorktree } from "../src/core/workspace/session-worktree.ts";

const directories: string[] = [];

afterEach(() => {
	for (const dir of directories.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-session-worktree-"));
	directories.push(dir);
	execFileSync("git", ["init", "-b", "main", dir]);
	execFileSync("git", ["-C", dir, "config", "user.email", "worktree@example.com"]);
	execFileSync("git", ["-C", dir, "config", "user.name", "worktree"]);
	writeFileSync(join(dir, "tracked.txt"), "seed\n", "utf-8");
	execFileSync("git", ["-C", dir, "add", "-A"]);
	execFileSync("git", ["-C", dir, "commit", "-m", "initial"]);
	return dir;
}

describe("session worktree", () => {
	it("refuses a name that escapes the worktrees directory before git runs", async () => {
		const dir = repo();
		await expect(prepareSessionWorktree(dir, "..")).rejects.toThrow(/not a safe path component/);
		expect(existsSync(join(dir, ".apex-code"))).toBe(false);
	});

	it("creates the linked worktree and removes it when clean", async () => {
		const dir = repo();
		const prepared = await prepareSessionWorktree(dir, "demo");
		expect(prepared.path).toBe(join(dir, ".apex-code", "worktrees", "demo"));
		expect(existsSync(join(prepared.path, "tracked.txt"))).toBe(true);
		const branch = execFileSync("git", ["-C", prepared.path, "rev-parse", "--abbrev-ref", "HEAD"], {
			encoding: "utf-8",
		}).trim();
		expect(branch).toBe("apex-session-demo");
		const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf-8" });
		expect(status).not.toContain(".apex-code/worktrees");

		const released = await releaseSessionWorktree(dir, "demo");
		expect(released.removed).toBe(true);
		expect(existsSync(prepared.path)).toBe(false);
	});

	it("keeps a dirty worktree and names its path", async () => {
		const dir = repo();
		const prepared = await prepareSessionWorktree(dir, "dirty");
		writeFileSync(join(prepared.path, "new.txt"), "untracked\n", "utf-8");
		const released = await releaseSessionWorktree(dir, "dirty");
		expect(released.removed).toBe(false);
		expect(released.kept).toBe("dirty");
		expect(released.path).toBe(prepared.path);
		expect(existsSync(prepared.path)).toBe(true);
	});

	it("refuses when the directory is not a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-session-worktree-"));
		directories.push(dir);
		await expect(prepareSessionWorktree(dir, "demo")).rejects.toThrow(/git repository/);
	});
});

describe("concurrent session refusal", () => {
	it("names the worktree flag and not a manual git command", () => {
		const lines: string[] = [];
		const error = console.error;
		console.error = (line?: unknown) => {
			lines.push(String(line));
		};
		const lease: SessionLease = { pid: 1, cwd: "/tmp/project", sessionId: "abc", startedAt: "2026-10-23T00:00:00Z" };
		try {
			reportConcurrentSessionRefusal([lease], "/tmp/project");
		} finally {
			console.error = error;
		}
		const text = lines.join("\n");
		expect(text).toContain("apex-code --worktree <name>");
		expect(text).toContain("--allow-concurrent");
		expect(text).not.toContain("git worktree add");
	});
});
