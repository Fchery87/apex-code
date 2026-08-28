/**
 * Owns when a server is running and nothing about how it is reached.
 *
 * The `McpConnection` seam is why this module has no MCP SDK import and no child
 * process: lifecycle is the part with the interesting failure modes (a connect that
 * never returns, a broken server retried on every call, two callers racing the same
 * spawn) and all of it is testable against a fake.
 */

import type { McpConnection, McpConnector, McpServerConfig, ServerState } from "./types.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const FAILURE_BACKOFF_MS = 60_000;

interface Entry {
	state: ServerState;
	connection: McpConnection | undefined;
	/** Held so concurrent callers await one spawn instead of racing a second. */
	pending: Promise<McpConnection> | undefined;
}

export interface McpServerManagerOptions {
	servers: ReadonlyMap<string, McpServerConfig>;
	connector: McpConnector;
	now?: () => number;
	connectTimeoutMs?: number;
}

function isKeptAlive(server: McpServerConfig): boolean {
	return server.lifecycle === "keep-alive" || server.lifecycle === "lazy-keep-alive";
}

export class McpServerManager {
	private readonly servers: ReadonlyMap<string, McpServerConfig>;
	private readonly connector: McpConnector;
	private readonly now: () => number;
	private readonly connectTimeoutMs: number;
	private readonly entries = new Map<string, Entry>();

	constructor(options: McpServerManagerOptions) {
		this.servers = options.servers;
		this.connector = options.connector;
		this.now = options.now ?? Date.now;
		this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	}

	state(name: string): ServerState {
		return this.entries.get(name)?.state ?? { kind: "disconnected" };
	}

	private entry(name: string): Entry {
		let entry = this.entries.get(name);
		if (!entry) {
			entry = { state: { kind: "disconnected" }, connection: undefined, pending: undefined };
			this.entries.set(name, entry);
		}
		return entry;
	}

	private async connect(server: McpServerConfig, entry: Entry): Promise<McpConnection> {
		entry.state = { kind: "connecting", since: this.now() };

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Connecting to MCP server "${server.name}" timed out`)),
				this.connectTimeoutMs,
			);
		});

		try {
			const connection = await Promise.race([this.connector(server), timeout]);
			const at = this.now();
			entry.connection = connection;
			entry.state = { kind: "ready", since: at, lastUsed: at };
			return connection;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			entry.connection = undefined;
			entry.state = {
				kind: "failed",
				error: message,
				failedAt: this.now(),
				retryAfter: this.now() + FAILURE_BACKOFF_MS,
			};
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
			entry.pending = undefined;
		}
	}

	private async acquire(name: string): Promise<McpConnection> {
		const server = this.servers.get(name);
		if (!server) throw new Error(`MCP server "${name}" is not configured`);

		const entry = this.entry(name);
		if (entry.state.kind === "ready" && entry.connection) return entry.connection;
		if (entry.pending) return entry.pending;

		// A server that just failed is not retried until its window passes, so one
		// broken server cannot cost every call a spawn attempt.
		if (entry.state.kind === "failed" && this.now() < entry.state.retryAfter) {
			throw new Error(entry.state.error);
		}

		entry.pending = this.connect(server, entry);
		return entry.pending;
	}

	async withConnection<T>(name: string, use: (connection: McpConnection) => Promise<T>): Promise<T> {
		const connection = await this.acquire(name);
		const result = await use(connection);

		const entry = this.entry(name);
		if (entry.state.kind === "ready") entry.state = { ...entry.state, lastUsed: this.now() };
		return result;
	}

	/** Close every `ready` server whose idle window has passed, unless it is kept alive. */
	async sweepIdle(): Promise<void> {
		const at = this.now();
		for (const [name, entry] of this.entries) {
			const server = this.servers.get(name);
			if (!server || entry.state.kind !== "ready" || isKeptAlive(server)) continue;
			if (at - entry.state.lastUsed < server.idleTimeoutMinutes * 60_000) continue;
			await this.disconnect(name, entry);
		}
	}

	private async disconnect(name: string, entry: Entry): Promise<void> {
		const connection = entry.connection;
		entry.connection = undefined;
		entry.state = { kind: "disconnected" };
		if (connection) {
			await connection.close().catch(() => undefined);
		}
		this.entries.set(name, entry);
	}

	async closeAll(): Promise<void> {
		for (const [name, entry] of this.entries) {
			await this.disconnect(name, entry);
		}
	}
}
