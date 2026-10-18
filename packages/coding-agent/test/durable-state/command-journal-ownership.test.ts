import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDurableStateStore } from "../../src/core/durable-state/sqlite.ts";

const tempDirs: string[] = [];
const stores: Array<{ close(): void }> = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function createDatabasePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-command-owner-"));
	tempDirs.push(dir);
	return join(dir, "state.sqlite");
}

function open(path: string) {
	const store = openDurableStateStore(path);
	stores.push(store);
	return store;
}

const liveOwner = { id: "live-process", pid: 4242 };
const deadOwner = { id: "dead-process", pid: 4343 };

describe("command journal ownership", () => {
	it("recovers only the commands whose owning process is no longer alive", () => {
		const path = createDatabasePath();
		const writer = open(path);
		const live = writer.beginCommand({ sessionId: "s1", command: "sleep 60", owner: liveOwner });
		const dead = writer.beginCommand({ sessionId: "s1", command: "sleep 61", owner: deadOwner });
		writer.transitionCommand(live.id, "running");
		writer.transitionCommand(dead.id, "running");

		const recovered = writer.recoverOrphanedCommands((owner) => owner?.id === liveOwner.id);

		expect(recovered.map((record) => record.id)).toEqual([dead.id]);
		expect(writer.getCommand(dead.id)).toMatchObject({ state: "interrupted" });
		expect(writer.getCommand(live.id)).toMatchObject({ state: "running" });
	});

	it("treats a command with no recorded owner as orphaned", () => {
		const store = open(createDatabasePath());
		const legacy = store.beginCommand({ sessionId: "s1", command: "sleep 62" });
		store.transitionCommand(legacy.id, "running");

		const recovered = store.recoverOrphanedCommands(() => true);

		expect(recovered.map((record) => record.id)).toEqual([legacy.id]);
		expect(store.getCommand(legacy.id)).toMatchObject({ state: "interrupted" });
	});

	it("recovers each orphan once even when two store handles run recovery", () => {
		const path = createDatabasePath();
		const first = open(path);
		const second = open(path);
		const orphan = first.beginCommand({ sessionId: "s1", command: "sleep 63", owner: deadOwner });
		first.transitionCommand(orphan.id, "running");

		const firstRecovery = first.recoverOrphanedCommands(() => false);
		const secondRecovery = second.recoverOrphanedCommands(() => false);

		expect(firstRecovery.map((record) => record.id)).toEqual([orphan.id]);
		expect(secondRecovery).toEqual([]);
		expect(second.getCommand(orphan.id)).toMatchObject({ state: "interrupted" });
	});

	it("opens the sidecar in WAL mode with a busy timeout so concurrent processes wait instead of failing", () => {
		const store = open(createDatabasePath());
		expect(store.pragmaValue("journal_mode")).toBe("wal");
		expect(store.pragmaValue("busy_timeout")).toBeGreaterThanOrEqual(1000);
	});
});

describe("command journal across a SIGKILL of the owning process", () => {
	it("recovers a command as interrupted, and never as completed, after its owner is killed", async () => {
		const { spawn } = await import("node:child_process");
		const { fileURLToPath } = await import("node:url");
		const { createCommandJournalRecorder } = await import("../../src/core/durable-state/command-journal.ts");
		const path = createDatabasePath();
		const fixture = fileURLToPath(new URL("./fixtures/journaled-owner.ts", import.meta.url));
		const owner = spawn(process.execPath, ["--import", "tsx", fixture, path], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		const ready = await new Promise<{ journalId: string; childPid: number }>((resolve, reject) => {
			let buffer = "";
			owner.stdout!.on("data", (chunk) => {
				buffer += chunk.toString();
				const line = buffer.split("\n").find((candidate) => candidate.includes('"ready"'));
				if (line) resolve(JSON.parse(line));
			});
			owner.on("exit", (code) => reject(new Error(`owner exited before readiness: ${code}`)));
		});
		try {
			expect(ownerPidExists(ready.childPid)).toBe(true);
			owner.kill("SIGKILL");
			await new Promise((resolve) => owner.on("exit", resolve));

			const recovery = createCommandJournalRecorder(path, "session-kill");
			const reader = open(path);
			const recovered = recovery.recoverOrphans();
			expect(recovered.map((record) => record.id)).toEqual([ready.journalId]);
			expect(reader.getCommand(ready.journalId)).toMatchObject({ state: "interrupted" });
			expect(reader.getCommand(ready.journalId)?.recoveryReason).toMatch(/owning process exited/);
			expect(recovery.recoverOrphans()).toEqual([]);
			recovery.close();
		} finally {
			try {
				process.kill(ready.childPid, "SIGKILL");
			} catch {
				// The command process already exited.
			}
		}
	});
});

function ownerPidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("command journal owners on another host", () => {
	it("does not interrupt a command whose owner ran on another host, even when its PID is not local", async () => {
		const { ownerIsAlive } = await import("../../src/core/durable-state/process-identity.ts");
		const path = createDatabasePath();
		const store = open(path);
		const remote = store.beginCommand({
			sessionId: "s1",
			command: "remote work",
			owner: { id: "remote", pid: 999_999, host: "another-host", boot: "boot-a" },
		});
		store.transitionCommand(remote.id, "running");

		const recovered = store.recoverOrphanedCommands((owner) => (owner ? ownerIsAlive(owner) : false));

		expect(recovered).toEqual([]);
		expect(store.getCommand(remote.id)).toMatchObject({ state: "running" });
	});
});

describe("command journal owners across a reboot", () => {
	it("recovers a command whose owner ran on this host before a reboot", async () => {
		const { ownerIsAlive } = await import("../../src/core/durable-state/process-identity.ts");
		const { hostname } = await import("node:os");
		const path = createDatabasePath();
		const store = open(path);
		const previousBoot = store.beginCommand({
			sessionId: "s1",
			command: "pre-reboot work",
			owner: { id: "pre-reboot", pid: 999_999, host: hostname(), boot: "boot-before-reboot" },
		});
		store.transitionCommand(previousBoot.id, "running");

		const recovered = store.recoverOrphanedCommands((owner) => (owner ? ownerIsAlive(owner) : false));

		expect(recovered.map((record) => record.id)).toEqual([previousBoot.id]);
		expect(store.getCommand(previousBoot.id)).toMatchObject({ state: "interrupted" });
	});
});
