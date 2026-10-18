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
 * can mark interrupted.
 *
 * Each operation opens the sidecar, works, and closes it. A handle held open for the life of
 * the process would keep `state.sqlite` locked, and Windows will not delete a locked file, so
 * temp-directory cleanup fails in every test that runs a session.
 */
export interface CommandJournalRecorder {
	/** Records the command and returns its journal id. Throws if the record cannot be written. */
	begin(command: string): string;
	/** Records how the command ended. A failure here leaves the row for recovery to mark. */
	finish(id: string, outcome: CommandOutcome): void;
	/** Records a command whose process never started, so recovery does not report it as interrupted. */
	fail(id: string, reason: string): void;
	/**
	 * Marks unfinished commands interrupted when their owning process has exited. Commands
	 * owned by a live process are left alone. Run once at session start.
	 */
	recoverOrphans(): CommandJournalRecord[];
	close(): void;
}

export function createCommandJournalRecorder(databasePath: string, sessionId: string): CommandJournalRecorder {
	const owner: ProcessOwner = currentProcessOwner(randomUUID());
	const withStore = <T>(operation: (store: DurableStateStore) => T): T => {
		const store = openDurableStateStore(databasePath);
		try {
			return operation(store);
		} finally {
			store.close();
		}
	};
	return {
		begin(command) {
			const id = randomUUID();
			withStore((store) => {
				store.beginCommand({ id, sessionId, command, owner });
				store.transitionCommand(id, "running");
			});
			return id;
		},
		finish(id, outcome) {
			try {
				withStore((store) => {
					if (outcome.killed) store.transitionCommand(id, "failed", "killed by user");
					else if (outcome.exitCode === 0) store.transitionCommand(id, "completed");
					else if (outcome.exitCode === null) store.transitionCommand(id, "failed", "terminated by signal");
					else store.transitionCommand(id, "failed", `exited with status ${outcome.exitCode}`);
				});
			} catch {
				// The row stays `running`. Recovery marks it interrupted once its owner has exited.
			}
		},
		fail(id, reason) {
			try {
				withStore((store) => store.transitionCommand(id, "failed", reason));
			} catch {
				// The row stays `created` or `running`. Recovery will mark it when its owner exits.
			}
		},
		recoverOrphans() {
			// A session that never journaled a command has no database to recover, so do not create one.
			if (!existsSync(databasePath)) return [];
			return withStore((store) =>
				store.recoverOrphanedCommands((orphanOwner) => orphanOwner !== undefined && ownerIsAlive(orphanOwner)),
			);
		},
		close() {},
	};
}
