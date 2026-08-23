/**
 * Liveness records for sessions sharing one working directory.
 *
 * Two Apex Code sessions in the same working tree overwrite each other's edits and
 * commits, and neither one can tell. Each process publishes its own lease file rather
 * than sharing one, so nothing here takes a lock and the startup path stays free of
 * `proper-lockfile`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionLease {
	pid: number;
	sessionId: string;
	/** ISO 8601. */
	startedAt: string;
	cwd: string;
}

export interface SessionLeaseHandle {
	release(): void;
}

const LEASE_DIR_NAME = "leases";

function leaseDir(sessionDir: string): string {
	return join(sessionDir, LEASE_DIR_NAME);
}

function leasePath(sessionDir: string, pid: number): string {
	return join(leaseDir(sessionDir), `${pid}.json`);
}

/**
 * Only ESRCH proves the process is gone. EPERM means it exists under another user, and
 * anything else means the probe itself failed, so treat both as alive: a session we
 * cannot rule out is worth warning about, and `--allow-concurrent` clears a false one.
 */
function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Reclaiming a lease is best effort. A read-only or hostile directory must not break startup. */
function discard(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {}
}

function parseLease(raw: string): SessionLease | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const { pid, sessionId, startedAt, cwd } = value as Record<string, unknown>;
	if (typeof pid !== "number" || typeof sessionId !== "string") {
		return undefined;
	}
	if (typeof startedAt !== "string" || typeof cwd !== "string") {
		return undefined;
	}
	return { pid, sessionId, startedAt, cwd };
}

/**
 * Live leases for `cwd`, excluding this process. Dead and unreadable leases are deleted
 * as they are found, so a crashed session never locks anyone out and repeated scans
 * converge on the same answer.
 */
export function readLiveSessionLeases(sessionDir: string, cwd: string): SessionLease[] {
	const dir = leaseDir(sessionDir);
	if (!existsSync(dir)) {
		return [];
	}

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const live: SessionLease[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const path = join(dir, entry);
		let lease: SessionLease | undefined;
		try {
			lease = parseLease(readFileSync(path, "utf-8"));
		} catch {
			lease = undefined;
		}

		if (!lease || !isProcessAlive(lease.pid)) {
			discard(path);
			continue;
		}
		if (lease.pid === process.pid || lease.cwd !== cwd) {
			continue;
		}
		live.push(lease);
	}

	return live.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Publish this process's lease. Failing to write one is never fatal: the lease is an
 * advisory signal to the next session, not something this session depends on.
 */
export function acquireSessionLease(sessionDir: string, cwd: string, sessionId: string): SessionLeaseHandle {
	const path = leasePath(sessionDir, process.pid);
	const lease: SessionLease = {
		pid: process.pid,
		sessionId,
		startedAt: new Date().toISOString(),
		cwd,
	};

	try {
		mkdirSync(leaseDir(sessionDir), { recursive: true });
		writeFileSync(path, `${JSON.stringify(lease, null, 2)}\n`, "utf-8");
	} catch {
		return { release: () => {} };
	}

	let released = false;
	return {
		release: () => {
			if (released) {
				return;
			}
			released = true;
			discard(path);
		},
	};
}

export function describeSessionLease(lease: SessionLease): string {
	const started = new Date(lease.startedAt);
	const when = Number.isNaN(started.getTime()) ? lease.startedAt : started.toLocaleTimeString();
	return `pid ${lease.pid}, started ${when}, session ${lease.sessionId.slice(0, 8)}`;
}
