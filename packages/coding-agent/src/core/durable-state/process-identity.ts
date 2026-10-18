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
	 * Host and boot identity. A PID means something only on the host and boot it came from.
	 * A sidecar in a shared agent directory can hold a row written by another host or container.
	 */
	readonly hostId?: string;
}

/** This host and boot. Two processes match only if both the host and the boot match. */
export function localHostId(): string {
	let boot = "";
	try {
		boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		// Not Linux, or /proc is unavailable. The host name alone is the identity then.
	}
	return `${hostname()}:${boot}`;
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
	return { id, pid: process.pid, startToken: processStartToken(process.pid), hostId: localHostId() };
}

/**
 * Whether the recorded owner is still the same live process. Where the start token cannot
 * be read, a live PID counts as the owner. That keeps a command running rather than
 * marking it interrupted on weak evidence.
 */
export function ownerIsAlive(owner: ProcessOwner): boolean {
	// Local PID checks prove nothing about a process on another host, namespace, or boot.
	if (owner.hostId !== undefined && owner.hostId !== localHostId()) return true;
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
