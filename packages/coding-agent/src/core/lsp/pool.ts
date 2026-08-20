import { LspClient } from "./client.ts";
import {
	type ResolvedLspRegistry,
	type ResolvedLspServer,
	type SelectedLspServer,
	selectLspServerForPath,
} from "./registry.ts";

const MAX_ATTEMPTS = 3;

type PoolEntryState = "starting" | "ready" | "degraded" | "disabled" | "closed";

interface PoolEntry {
	readonly server: ResolvedLspServer;
	readonly root: string;
	attempts: number;
	state: PoolEntryState;
	reason?: string;
	client?: LspClient;
	startPromise?: Promise<LspClient>;
	unsubscribeFailure?: () => void;
}

export interface LspPoolOptions {
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * Invoked synchronously on every server-root state transition (starting, ready,
	 * degraded, disabled, closed) so a caller can build a chronological status history
	 * across the pool's whole lifetime, not just a single snapshot (LSP.2).
	 */
	readonly onStatusChange?: (status: LspPoolStatus) => void;
}

export interface LspPoolConnection {
	readonly client: LspClient;
	readonly selection: SelectedLspServer;
}

export interface LspPoolStatus {
	readonly serverId: string;
	readonly root: string;
	readonly state: PoolEntryState;
	readonly attempts: number;
	readonly reason?: string;
}

function entryKey(serverId: string, root: string): string {
	return `${serverId}\0${root}`;
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** Owns and bounds language-server clients for one resolved workspace registry. */
export class LspPool {
	private readonly registry: ResolvedLspRegistry;
	private readonly options: LspPoolOptions;
	private readonly entries = new Map<string, PoolEntry>();
	private startPromise: Promise<void> | undefined;
	private disposePromise: Promise<void> | undefined;
	private closing = false;

	constructor(registry: ResolvedLspRegistry, options: LspPoolOptions = {}) {
		this.registry = registry;
		this.options = options;
	}

	/** Eagerly initialize the workspace-root process for every configured server. */
	start(): Promise<void> {
		if (this.closing) return Promise.reject(new Error("LSP pool is disposed."));
		this.startPromise ??= Promise.all(
			this.registry.servers.map((server) =>
				this.ensureClient(this.getOrCreateEntry(server, this.registry.workspace)),
			),
		).then(() => undefined);
		return this.startPromise;
	}

	/** Select a file's server/root and return its ready shared client. */
	async acquire(path: string): Promise<LspPoolConnection | undefined> {
		if (this.closing) throw new Error("LSP pool is disposed.");
		const selection = selectLspServerForPath(this.registry, path);
		if (!selection) return undefined;
		const client = await this.ensureClient(this.getOrCreateEntry(selection.server, selection.root));
		return { client, selection };
	}

	status(): readonly LspPoolStatus[] {
		return [...this.entries.values()]
			.map((entry) => this.toStatus(entry))
			.sort((left, right) =>
				left.serverId === right.serverId
					? left.root.localeCompare(right.root)
					: left.serverId.localeCompare(right.serverId),
			);
	}

	dispose(): Promise<void> {
		this.disposePromise ??= this.disposeEntries();
		return this.disposePromise;
	}

	private getOrCreateEntry(server: ResolvedLspServer, root: string): PoolEntry {
		const key = entryKey(server.id, root);
		let entry = this.entries.get(key);
		if (!entry) {
			entry = { server, root, attempts: 0, state: "degraded" };
			this.entries.set(key, entry);
		}
		return entry;
	}

	private ensureClient(entry: PoolEntry): Promise<LspClient> {
		if (entry.state === "disabled") {
			return Promise.reject(
				new Error(
					`LSP server ${entry.server.id} at ${entry.root} is disabled after ${entry.attempts} attempts: ${entry.reason}`,
				),
			);
		}
		if (entry.state === "closed" || this.closing) return Promise.reject(new Error("LSP pool is disposed."));
		if (entry.state === "ready" && entry.client) return Promise.resolve(entry.client);
		if (entry.startPromise) return entry.startPromise;
		if (entry.attempts >= MAX_ATTEMPTS) {
			this.disable(entry, entry.reason ?? "attempt limit reached");
			return this.ensureClient(entry);
		}

		entry.attempts += 1;
		entry.state = "starting";
		entry.reason = undefined;
		this.emitStatus(entry);
		const client = new LspClient({
			command: entry.server.command,
			args: entry.server.args,
			cwd: entry.root,
			env: this.options.env,
			initializationTimeoutMs: entry.server.initializationTimeoutMs,
			requestTimeoutMs: entry.server.requestTimeoutMs,
		});
		entry.client = client;
		entry.unsubscribeFailure = client.onFailure((error) => this.onClientFailure(entry, client, error));
		entry.startPromise = client
			.start()
			.then(() => {
				if (this.closing) throw new Error("LSP pool is disposed.");
				entry.state = "ready";
				this.emitStatus(entry);
				return client;
			})
			.catch((error) => {
				this.onClientFailure(entry, client, normalizeError(error));
				throw error;
			})
			.finally(() => {
				entry.startPromise = undefined;
			});
		return entry.startPromise;
	}

	private onClientFailure(entry: PoolEntry, client: LspClient, error: Error): void {
		if (entry.client !== client || entry.state === "closed" || this.closing) return;
		entry.unsubscribeFailure?.();
		entry.unsubscribeFailure = undefined;
		entry.client = undefined;
		entry.reason = error.message;
		if (entry.attempts >= MAX_ATTEMPTS) {
			this.disable(entry, error.message);
		} else {
			entry.state = "degraded";
			this.emitStatus(entry);
		}
		void client.dispose();
	}

	private disable(entry: PoolEntry, reason: string): void {
		entry.state = "disabled";
		entry.reason = reason;
		this.emitStatus(entry);
	}

	private toStatus(entry: PoolEntry): LspPoolStatus {
		return {
			serverId: entry.server.id,
			root: entry.root,
			state: entry.state,
			attempts: entry.attempts,
			...(entry.reason === undefined ? {} : { reason: entry.reason }),
		};
	}

	private emitStatus(entry: PoolEntry): void {
		this.options.onStatusChange?.(this.toStatus(entry));
	}

	private async disposeEntries(): Promise<void> {
		this.closing = true;
		await Promise.allSettled(
			[...this.entries.values()].map(async (entry) => {
				entry.unsubscribeFailure?.();
				entry.unsubscribeFailure = undefined;
				await entry.client?.dispose();
				entry.client = undefined;
				entry.state = "closed";
				this.emitStatus(entry);
			}),
		);
	}
}
