import { readFileSync } from "node:fs";
import { hostname } from "node:os";

/**
 * The process that owns a journaled command. A PID alone is not identity, because the
 * kernel reuses PIDs. On Linux the start token (field 22 of /proc/<pid>/stat, in clock
 * ticks since boot) changes when a PID is reused, so a match proves the same process.
 */
export interface ProcessOwner {
	readonly id: string;
	readonly pid: number;
	readonly startToken?: string;
	/**
	 * The machine the PID belongs to. A sidecar in a shared agent directory can hold rows written
	 * by another host or container, whose PIDs mean nothing here.
	 */
	readonly host?: string;
	/** The boot the PID belongs to. After a reboot every process from the old boot has exited. */
	readonly boot?: string;
}

export function localHost(): string {
	return hostname();
}

/** This boot's id, or "" where /proc is unavailable. */
export function localBoot(): string {
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		return "";
	}
}

/** Linux start time for a PID, or undefined where /proc is unavailable. */
export function processStartToken(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name is parenthesised and may contain spaces, so parse after the last ")".
		// The first field after it is field 3, so field 22 is at index 19.
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch {
		return undefined;
	}
}

export function currentProcessOwner(id: string): ProcessOwner {
	return {
		id,
		pid: process.pid,
		startToken: processStartToken(process.pid),
		host: localHost(),
		boot: localBoot(),
	};
}

/**
 * Whether the recorded owner is still the same live process. Where the start token cannot
 * be read, a live PID counts as the owner. That keeps a command running rather than
 * marking it interrupted on weak evidence.
 */
export function ownerIsAlive(owner: ProcessOwner): boolean {
	// A PID from another host proves nothing here, so do not interrupt on weak evidence.
	if (owner.host !== undefined && owner.host !== localHost()) return true;
	// Every process from an earlier boot has exited.
	if (owner.boot !== undefined && owner.boot !== localBoot()) return false;
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		// EPERM means the PID exists but belongs to another user, so it is still alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
	if (owner.startToken === undefined) return true;
	const current = processStartToken(owner.pid);
	return current === undefined || current === owner.startToken;
}
