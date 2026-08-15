import { type GitProvenance, readGitProvenance } from "./provenance.ts";
import {
	type CommandJournalRecord,
	type DurableStateStore,
	openDurableStateStore,
	type RecoveryDiagnostic,
	type SessionLeaseMode,
	type SessionLeaseRecord,
} from "./sqlite.ts";

export interface DurableStateDaemonOptions {
	databasePath: string;
	daemonId: string;
	cwd?: string;
}
export interface AttachClientInput {
	sessionId: string;
	clientId: string;
	mode: SessionLeaseMode;
	ttlMs: number;
}
export interface MutationInput {
	id?: string;
	sessionId: string;
	clientId: string;
	command: string;
}

/**
 * Local daemon state coordinator. All session mutations are admitted through a
 * durable lease and journaled before the caller receives its operation callback.
 */
export class DurableStateDaemon {
	readonly recoveryDiagnostics: readonly RecoveryDiagnostic[];
	readonly provenance: GitProvenance;
	readonly #store: DurableStateStore;
	readonly #attachments = new Map<string, Map<string, SessionLeaseRecord>>();

	constructor(options: DurableStateDaemonOptions) {
		this.#store = openDurableStateStore(options.databasePath);
		this.provenance = readGitProvenance(options.cwd ?? process.cwd());
		this.recoveryDiagnostics = this.#store.recoverUnfinishedCommandsWithDiagnostics(
			`daemon ${options.daemonId} started before command completion`,
		);
	}

	attach(input: AttachClientInput): SessionLeaseRecord {
		const lease = this.#store.acquireLease({
			sessionId: input.sessionId,
			ownerId: input.clientId,
			mode: input.mode,
			ttlMs: input.ttlMs,
		});
		const clients = this.#attachments.get(input.sessionId) ?? new Map<string, SessionLeaseRecord>();
		clients.set(input.clientId, lease);
		this.#attachments.set(input.sessionId, clients);
		return lease;
	}

	detach(sessionId: string, clientId: string): void {
		this.#store.releaseLease(sessionId, clientId);
		const clients = this.#attachments.get(sessionId);
		if (!clients) return;
		clients.delete(clientId);
		if (clients.size === 0) this.#attachments.delete(sessionId);
	}

	beginMutation(input: MutationInput): CommandJournalRecord {
		this.#requireExclusiveAttachment(input.sessionId, input.clientId);
		return this.#store.beginCommand({ id: input.id, sessionId: input.sessionId, command: input.command });
	}

	async runMutation<T>(input: MutationInput, operation: () => Promise<T>): Promise<T> {
		this.#requireExclusiveAttachment(input.sessionId, input.clientId);
		return this.#store.runCommand({ id: input.id, sessionId: input.sessionId, command: input.command }, operation);
	}

	getCommand(id: string): CommandJournalRecord | undefined {
		return this.#store.getCommand(id);
	}
	getCommandCount(): number {
		return this.#store.commandCount();
	}
	dispose(): void {
		this.#store.close();
	}

	#requireExclusiveAttachment(sessionId: string, clientId: string): void {
		const attachment = this.#attachments.get(sessionId)?.get(clientId);
		if (!attachment || attachment.mode !== "exclusive" || Date.parse(attachment.expiresAt) <= Date.now()) {
			throw new Error(`Client does not hold an active exclusive lease for ${sessionId}`);
		}
	}
}
