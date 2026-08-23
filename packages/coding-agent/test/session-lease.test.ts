import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireSessionLease,
	describeSessionLease,
	readLiveSessionLeases,
	type SessionLease,
} from "../src/core/session-lease.ts";

const scratchDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
	}
	for (const dir of scratchDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-lease-"));
	scratchDirs.push(dir);
	return dir;
}

/** A process that stays up until the test ends, so its pid is genuinely alive. */
async function liveProcess(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	children.push(child);
	await new Promise((resolve) => setTimeout(resolve, 50));
	return child.pid as number;
}

/** A pid that is definitely gone: spawn, then wait for exit. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid as number;
	await new Promise((resolve) => child.on("exit", resolve));
	return pid;
}

function writeLease(sessionDir: string, lease: Partial<SessionLease> & { pid: number }): string {
	const dir = join(sessionDir, "leases");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${lease.pid}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			sessionId: "session-abcdef123456",
			startedAt: new Date().toISOString(),
			cwd: "/work",
			...lease,
		}),
	);
	return path;
}

describe("readLiveSessionLeases", () => {
	it("reports nothing when no session has ever run here", () => {
		expect(readLiveSessionLeases(scratch(), "/work")).toEqual([]);
	});

	it("reports a sibling session whose process is alive", async () => {
		const dir = scratch();
		const pid = await liveProcess();
		writeLease(dir, { pid });

		const live = readLiveSessionLeases(dir, "/work");

		expect(live).toHaveLength(1);
		expect(live[0]?.pid).toBe(pid);
	});

	it("reclaims a crashed session's lease instead of locking the directory", async () => {
		const dir = scratch();
		const path = writeLease(dir, { pid: await deadPid() });

		expect(readLiveSessionLeases(dir, "/work")).toEqual([]);
		expect(existsSync(path)).toBe(false);
	});

	it("deletes a lease it cannot parse rather than treating it as live", () => {
		const dir = scratch();
		const leaseDir = join(dir, "leases");
		mkdirSync(leaseDir, { recursive: true });
		const path = join(leaseDir, "999999.json");
		writeFileSync(path, "{ not json");

		expect(readLiveSessionLeases(dir, "/work")).toEqual([]);
		expect(existsSync(path)).toBe(false);
	});

	it("ignores a live session that holds a different working directory", async () => {
		const dir = scratch();
		writeLease(dir, { pid: await liveProcess(), cwd: "/somewhere/else" });

		expect(readLiveSessionLeases(dir, "/work")).toEqual([]);
	});

	it("never reports the calling process to itself", () => {
		const dir = scratch();
		writeLease(dir, { pid: process.pid });

		expect(readLiveSessionLeases(dir, "/work")).toEqual([]);
	});

	it("treats a probe that fails for any reason other than ESRCH as still alive", async () => {
		const dir = scratch();
		const pid = await deadPid();
		writeLease(dir, { pid });
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("probe blocked"), { code: "EPERM" });
		});

		try {
			expect(readLiveSessionLeases(dir, "/work").map((l) => l.pid)).toEqual([pid]);
		} finally {
			kill.mockRestore();
		}
	});

	it("survives a lease it cannot delete rather than failing startup", async () => {
		const dir = scratch();
		writeLease(dir, { pid: await deadPid() });
		const leaseDir = join(dir, "leases");
		chmodSync(leaseDir, 0o555);

		try {
			expect(() => readLiveSessionLeases(dir, "/work")).not.toThrow();
		} finally {
			chmodSync(leaseDir, 0o755);
		}
	});

	it("converges on repeated scans", async () => {
		const dir = scratch();
		writeLease(dir, { pid: await deadPid() });
		const livePid = await liveProcess();
		writeLease(dir, { pid: livePid });

		const first = readLiveSessionLeases(dir, "/work");
		const second = readLiveSessionLeases(dir, "/work");

		expect(first.map((l) => l.pid)).toEqual([livePid]);
		expect(second.map((l) => l.pid)).toEqual([livePid]);
		expect(readdirSync(join(dir, "leases"))).toEqual([`${livePid}.json`]);
	});
});

describe("acquireSessionLease", () => {
	it("publishes a lease another session can see, and withdraws it on release", () => {
		const dir = scratch();
		const handle = acquireSessionLease(dir, "/work", "session-abcdef123456");
		const path = join(dir, "leases", `${process.pid}.json`);

		expect(existsSync(path)).toBe(true);

		handle.release();
		expect(existsSync(path)).toBe(false);
	});

	it("survives an unusable session directory rather than failing startup", () => {
		const dir = scratch();
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");

		const handle = acquireSessionLease(blocker, "/work", "session-abcdef123456");

		expect(() => handle.release()).not.toThrow();
	});

	it("is safe to release twice", () => {
		const handle = acquireSessionLease(scratch(), "/work", "session-abcdef123456");
		handle.release();
		expect(() => handle.release()).not.toThrow();
	});
});

describe("describeSessionLease", () => {
	it("names the pid and a short session id", () => {
		const text = describeSessionLease({
			pid: 41233,
			sessionId: "0aa2b380eec2bb99",
			startedAt: "2026-08-22T12:45:02.000Z",
			cwd: "/work",
		});

		expect(text).toContain("pid 41233");
		expect(text).toContain("0aa2b380");
		expect(text).not.toContain("eec2bb99");
	});
});
