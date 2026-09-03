import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceArtifactStore, workspaceArtifactDirFor } from "../../src/core/workspace/artifacts.ts";

/**
 * Bounded workspace artifact store (WS.3, spec §2). Proves atomic writes,
 * integrity, bounds, retention, cleanup, permission-gated retrieval, and
 * safe handling of interrupted writes.
 */

let scratch: string;
let sessionFile: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "apex-workspace-artifacts-"));
	sessionFile = join(scratch, "sessions", "2026-09-02T00-00-00_test-session.jsonl");
	mkdirSync(join(scratch, "sessions"), { recursive: true });
});

afterEach(() => {
	rmSync(scratch, { force: true, recursive: true });
});

function store(): WorkspaceArtifactStore {
	return new WorkspaceArtifactStore(sessionFile);
}

const PERMITTED = { allowed: true } as const;

describe("workspace artifact directory", () => {
	it("derives a sibling .artifacts directory from the session file", () => {
		const dir = workspaceArtifactDirFor(sessionFile);
		expect(dir.startsWith(scratch)).toBe(true);
		expect(dir).toContain("2026-09-02T00-00-00_test-session.artifacts");
		expect(dir.endsWith("workspace-state")).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});
});

describe("workspace artifact writes", () => {
	it("writes atomically with restrictive permissions and a matching hash", async () => {
		const s = store();
		const ref = await s.writeArtifact(Buffer.from("patch bytes"));

		expect(existsSync(join(s.dir, ref.file))).toBe(true);
		expect(ref.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(ref.bytes).toBe(11);
		if (process.platform !== "win32") {
			expect(statSync(s.dir).mode & 0o777).toBe(0o700);
			expect(statSync(join(s.dir, ref.file)).mode & 0o777).toBe(0o600);
		}
	});

	it("leaves no temp file behind after a successful write", async () => {
		const s = store();
		await s.writeArtifact(Buffer.from("data"));
		const files = readdirSync(s.dir).filter((f) => !f.startsWith("."));
		expect(files).toHaveLength(1);
		expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	it("ignores and cleans up stale temp files from interrupted writes", async () => {
		const s = store();
		mkdirSync(s.dir, { recursive: true });
		writeFileSync(join(s.dir, "leftover.tmp"), "partial write");
		const ref = await s.writeArtifact(Buffer.from("real artifact"));

		const names = readdirSync(s.dir);
		expect(names).toEqual([ref.file]);
		const read = await s.readArtifact(ref, PERMITTED);
		expect(read).toEqual({ ok: true, bytes: Buffer.from("real artifact") });
	});

	it("refuses an aborted signal before touching the filesystem", async () => {
		const s = store();
		const controller = new AbortController();
		controller.abort();
		await expect(s.writeArtifact(Buffer.from("x"), { signal: controller.signal })).rejects.toThrow(/cancel/i);
		expect(existsSync(s.dir)).toBe(false);
	});
});

describe("workspace artifact reads", () => {
	it("reads back exact bytes for a valid reference", async () => {
		const s = store();
		const payload = Buffer.from("round trip payload");
		const ref = await s.writeArtifact(payload);
		const read = await s.readArtifact(ref, PERMITTED);
		expect(read).toEqual({ ok: true, bytes: payload });
	});

	it("reports integrity failure for tampered bytes", async () => {
		const s = store();
		const ref = await s.writeArtifact(Buffer.from("honest bytes"));
		writeFileSync(join(s.dir, ref.file), "tampered!!!"); // same length is enough: hash must catch it
		const read = await s.readArtifact(ref, PERMITTED);
		expect(read).toEqual({ ok: false, reason: "integrity" });
	});

	it("reports missing for a reference whose file is gone", async () => {
		const s = store();
		const ref = await s.writeArtifact(Buffer.from("gone soon"));
		rmSync(join(s.dir, ref.file));
		const read = await s.readArtifact(ref, PERMITTED);
		expect(read).toEqual({ ok: false, reason: "missing" });
	});

	it("reports missing when the store directory does not exist", async () => {
		const s = store();
		const read = await s.readArtifact(
			{ artifactId: "a", file: "a.patch", sha256: `sha256:${"0".repeat(64)}`, bytes: 1 },
			PERMITTED,
		);
		expect(read).toEqual({ ok: false, reason: "missing" });
	});

	it("rejects references that escape the store directory", async () => {
		const s = store();
		for (const file of ["../escape.patch", "sub/dir.patch", "", "..", ".hidden-tmp"]) {
			const read = await s.readArtifact(
				{ artifactId: "x", file, sha256: `sha256:${"0".repeat(64)}`, bytes: 1 },
				PERMITTED,
			);
			expect(read).toEqual({ ok: false, reason: "invalid-ref" });
		}
		// Nothing escaped onto disk.
		expect(existsSync(join(scratch, "escape.patch"))).toBe(false);
	});

	it("denies retrieval without permission before probing the filesystem", async () => {
		const s = store();
		const ref = await s.writeArtifact(Buffer.from("secret patch"));
		const denied = await s.readArtifact(ref, { allowed: false, reason: "user has not approved patch retrieval" });
		expect(denied).toEqual({ ok: false, reason: "denied" });
		// Denial must not leak existence: a fake ref is also just "denied".
		const fake = await s.readArtifact(
			{ artifactId: "nope", file: "nope.patch", sha256: `sha256:${"0".repeat(64)}`, bytes: 0 },
			{ allowed: false, reason: "no" },
		);
		expect(fake).toEqual({ ok: false, reason: "denied" });
	});
});

describe("workspace artifact bounds and retention", () => {
	it("refuses a payload over the per-artifact byte cap", async () => {
		const s = store();
		await expect(s.writeArtifact(Buffer.alloc(64, 1), { maxBytes: 32 })).rejects.toThrow(/too large|exceeds/i);
		expect(existsSync(s.dir)).toBe(false);
	});

	it("retains only the newest artifacts within the count cap", async () => {
		const s = store();
		const refs = [];
		for (let i = 0; i < 5; i++) {
			refs.push(await s.writeArtifact(Buffer.from(`artifact-${i}`), { maxArtifacts: 3 }));
		}
		const surviving = s.listArtifactsSync().map((r) => r.file);
		expect(surviving).toHaveLength(3);
		const firstTwoGone = await Promise.all(refs.slice(0, 2).map((r) => s.readArtifact(r, PERMITTED)));
		expect(firstTwoGone.every((r) => r.ok === false && r.reason === "missing")).toBe(true);
		const lastTwoAlive = await Promise.all(refs.slice(2).map((r) => s.readArtifact(r, PERMITTED)));
		expect(lastTwoAlive.every((r) => r.ok)).toBe(true);
	});

	it("prunes oldest-first until total retained bytes fit the cap", async () => {
		const s = store();
		const a = await s.writeArtifact(Buffer.alloc(100, 1), { maxTotalBytes: 150 });
		const b = await s.writeArtifact(Buffer.alloc(100, 2), { maxTotalBytes: 150 });
		// a+b = 200 > 150, so `a` (oldest) must be gone, `b` retained.
		expect((await s.readArtifact(a, PERMITTED)).ok).toBe(false);
		expect((await s.readArtifact(b, PERMITTED)).ok).toBe(true);
		const c = await s.writeArtifact(Buffer.alloc(100, 3), { maxTotalBytes: 150 });
		expect((await s.readArtifact(b, PERMITTED)).ok).toBe(false);
		expect((await s.readArtifact(c, PERMITTED)).ok).toBe(true);
	});

	it("removes the whole artifact directory on cleanup", async () => {
		const s = store();
		await s.writeArtifact(Buffer.from("x"));
		expect(existsSync(s.dir)).toBe(true);
		await s.removeAll();
		expect(existsSync(s.dir)).toBe(false);
	});
});
