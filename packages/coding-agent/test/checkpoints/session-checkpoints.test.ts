import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionCheckpoints } from "../../src/core/checkpoints/session-checkpoints.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function repository(): string {
	const cwd = mkdtempSync(join(tmpdir(), "apex-session-checkpoints-"));
	directories.push(cwd);
	git(cwd, "init", "-q", ".");
	git(cwd, "config", "user.email", "fixture@example.com");
	git(cwd, "config", "user.name", "fixture");
	writeFileSync(join(cwd, "tracked.txt"), "v1\n");
	git(cwd, "add", "-A");
	git(cwd, "commit", "-qm", "base");
	return cwd;
}

function refs(cwd: string): string[] {
	return git(cwd, "for-each-ref", "--format=%(refname)", "refs/apex-code/").split("\n").filter(Boolean);
}

describe("session checkpoints", () => {
	it("captures by default when the setting is absent", async () => {
		const cwd = repository();
		const checkpoints = createSessionCheckpoints({ workspace: cwd, sessionId: "session", settings: undefined });
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");

		expect((await checkpoints.capture("entry-1"))?.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(refs(cwd)).toEqual(["refs/apex-code/checkpoints/session/entry-1"]);
	});

	it("writes no ref when the setting is present but disabled", async () => {
		const cwd = repository();
		const checkpoints = createSessionCheckpoints({
			workspace: cwd,
			sessionId: "session",
			settings: { enabled: false },
		});

		expect(await checkpoints.capture("entry-1")).toBeUndefined();
		expect(refs(cwd)).toEqual([]);
	});

	it("captures once enabled", async () => {
		const cwd = repository();
		const checkpoints = createSessionCheckpoints({
			workspace: cwd,
			sessionId: "session",
			settings: { enabled: true },
		});
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");

		expect((await checkpoints.capture("entry-1"))?.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(refs(cwd)).toEqual(["refs/apex-code/checkpoints/session/entry-1"]);
	});

	it("resolves the engine once and reuses it across captures", async () => {
		const cwd = repository();
		const checkpoints = createSessionCheckpoints({
			workspace: cwd,
			sessionId: "session",
			settings: { enabled: true },
		});

		await checkpoints.capture("entry-1");
		writeFileSync(join(cwd, "tracked.txt"), "v2\n");
		await checkpoints.capture("entry-2");

		expect(refs(cwd).length).toBe(2);
	});

	it("stays inert outside a git repository rather than throwing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "apex-session-checkpoints-nogit-"));
		directories.push(cwd);
		const checkpoints = createSessionCheckpoints({
			workspace: cwd,
			sessionId: "session",
			settings: { enabled: true },
		});

		// A user who turns checkpoints on globally and then opens a directory that is not a
		// repository must get a working session, not a failing turn.
		expect(await checkpoints.capture("entry-1")).toBeUndefined();
	});

	it("passes maxPerSession through to the engine", async () => {
		const cwd = repository();
		const checkpoints = createSessionCheckpoints({
			workspace: cwd,
			sessionId: "session",
			settings: { enabled: true, maxPerSession: 1 },
		});

		for (const entryId of ["entry-1", "entry-2"]) {
			writeFileSync(join(cwd, "tracked.txt"), `${entryId}\n`);
			await checkpoints.capture(entryId);
		}

		expect(refs(cwd)).toEqual(["refs/apex-code/checkpoints/session/entry-2"]);
	});
});
