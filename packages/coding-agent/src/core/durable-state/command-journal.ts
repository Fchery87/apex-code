import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { currentProcessOwner, ownerIsAlive, type ProcessOwner } from "./process-identity.ts";
import { type CommandJournalRecord, type DurableStateStore, openDurableStateStore } from "./sqlite.ts";

export interface CommandOutcome {
	readonly exitCode: number | null;
	readonly killed: boolean;
}

/**
 * Writes one durable record per long-running command. The record is written as `running`
 * before the caller starts the process, so a crash after launch leaves a row that recovery
 * can mark interrupted. Opening is lazy, so a session that never runs a background command
 * never touches the sidecar.
 */
export interface CommandJournalRecorder {
	/** Records the command and returns its journal id. Throws if the record cannot be written. */
	begin(command: string): string;
	/** Records how the command ended. A failure here leaves the row for recovery to mark. */
	finish(id: string, outcome: CommandOutcome): void;
	/**
	 * Marks unfinished commands interrupted when their owning process has exited. Commands
	 * owned by a live process are left alone. Run once at session start.
	 */
	recoverOrphans(): CommandJournalRecord[];
	close(): void;
}

export function createCommandJournalRecorder(databasePath: string, sessionId: string): CommandJournalRecorder {
	const owner: ProcessOwner = currentProcessOwner(randomUUID());
	let store: DurableStateStore | undefined;
	const open = (): DurableStateStore => {
		store ??= openDurableStateStore(databasePath);
		return store;
	};
	return {
		begin(command) {
			const db = open();
			const id = randomUUID();
			db.beginCommand({ id, sessionId, command, owner });
			db.transitionCommand(id, "running");
			return id;
		},
		finish(id, outcome) {
			try {
				const db = open();
				if (outcome.killed) db.transitionCommand(id, "failed", "killed by user");
				else if (outcome.exitCode === 0) db.transitionCommand(id, "completed");
				else if (outcome.exitCode === null) db.transitionCommand(id, "failed", "terminated by signal");
				else db.transitionCommand(id, "failed", `exited with status ${outcome.exitCode}`);
			} catch {
				// The row stays `running`. Recovery marks it interrupted once its owner has exited.
			}
		},
		recoverOrphans() {
			// A session that never journaled a command has no database to recover, so do not create one.
			if (!existsSync(databasePath)) return [];
			return open().recoverOrphanedCommands((owner) => owner !== undefined && ownerIsAlive(owner));
		},
		close() {
			store?.close();
			store = undefined;
		},
	};
}
