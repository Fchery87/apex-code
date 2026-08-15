import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** Current schema for the daemon-owned durable-state sidecar. */
export const CURRENT_DURABLE_STATE_SCHEMA_VERSION = 3;

export type CommandJournalState = "created" | "running" | "completed" | "failed" | "interrupted";

export type SessionLeaseMode = "shared" | "exclusive";
export interface SessionLeaseRecord {
	sessionId: string;
	ownerId: string;
	mode: SessionLeaseMode;
	expiresAt: string;
}

export interface CommandJournalRecord {
	id: string;
	sessionId: string;
	command: string;
	state: CommandJournalState;
	createdAt: string;
	updatedAt: string;
	recoveryReason?: string;
}

const COMMAND_TRANSITIONS: Record<CommandJournalState, readonly CommandJournalState[]> = {
	created: ["running", "failed", "interrupted"],
	running: ["completed", "failed", "interrupted"],
	completed: [],
	failed: [],
	interrupted: [],
};

const TABLES = [
	"cache_entries",
	"command_journal",
	"daemon_metadata",
	"model_performance",
	"schema_migrations",
	"session_leases",
	"usage_totals",
] as const;

export interface RecoveryDiagnostic {
	commandId: string;
	sessionId: string;
	previousState: "created" | "running";
	state: "interrupted";
	reason: string;
	recoveredAt: string;
}

export interface DurableStateStore {
	schemaVersion(): number;
	tableNames(): string[];
	columns(tableName: string): string[];
	beginCommand(input: { id?: string; sessionId: string; command: string }): CommandJournalRecord;
	transitionCommand(id: string, state: Exclude<CommandJournalState, "created">, reason?: string): CommandJournalRecord;
	getCommand(id: string): CommandJournalRecord | undefined;
	recoverUnfinishedCommands(reason?: string): CommandJournalRecord[];
	recoverUnfinishedCommandsWithDiagnostics(reason?: string): RecoveryDiagnostic[];
	acquireLease(input: {
		sessionId: string;
		ownerId: string;
		mode: SessionLeaseMode;
		ttlMs: number;
	}): SessionLeaseRecord;
	releaseLease(sessionId: string, ownerId: string): void;
	getLease(sessionId: string): SessionLeaseRecord | undefined;
	close(): void;
}

function readSchemaVersion(database: DatabaseSync): number {
	const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as
		| { version: number }
		| undefined;
	return row?.version ?? 0;
}

function createSchema(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS daemon_metadata (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS command_journal (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			command TEXT NOT NULL,
			state TEXT NOT NULL,
			recovery_reason TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS session_leases (
			session_id TEXT NOT NULL,
			owner_id TEXT NOT NULL,
			mode TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			PRIMARY KEY (session_id, owner_id)
		);
		CREATE TABLE IF NOT EXISTS usage_totals (
			session_id TEXT PRIMARY KEY,
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			cache_write_tokens INTEGER NOT NULL DEFAULT 0,
			cost REAL NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS model_performance (
			id INTEGER PRIMARY KEY,
			provider TEXT NOT NULL,
			model_id TEXT NOT NULL,
			ttft_ms REAL,
			generation_ms REAL,
			sampled_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS cache_entries (
			key TEXT PRIMARY KEY,
			value BLOB NOT NULL,
			expires_at TEXT
		);
	`);
}

function readCommand(database: DatabaseSync, id: string): CommandJournalRecord | undefined {
	const row = database
		.prepare(
			"SELECT id, session_id, command, state, recovery_reason, created_at, updated_at FROM command_journal WHERE id = ?",
		)
		.get(id) as
		| {
				id: string;
				session_id: string;
				command: string;
				state: CommandJournalState;
				recovery_reason: string | null;
				created_at: string;
				updated_at: string;
		  }
		| undefined;
	if (!row) return undefined;
	return {
		id: row.id,
		sessionId: row.session_id,
		command: row.command,
		state: row.state,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		...(row.recovery_reason ? { recoveryReason: row.recovery_reason } : {}),
	};
}

function readLeases(database: DatabaseSync, sessionId: string): SessionLeaseRecord[] {
	const rows = database
		.prepare(
			"SELECT session_id, owner_id, mode, expires_at FROM session_leases WHERE session_id = ? ORDER BY owner_id",
		)
		.all(sessionId) as Array<{ session_id: string; owner_id: string; mode: SessionLeaseMode; expires_at: string }>;
	return rows.map((row) => ({
		sessionId: row.session_id,
		ownerId: row.owner_id,
		mode: row.mode,
		expiresAt: row.expires_at,
	}));
}

function readLease(database: DatabaseSync, sessionId: string): SessionLeaseRecord | undefined {
	return readLeases(database, sessionId)[0];
}

function transitionCommand(
	database: DatabaseSync,
	id: string,
	state: Exclude<CommandJournalState, "created">,
	reason?: string,
): CommandJournalRecord {
	const current = readCommand(database, id);
	if (!current) throw new Error(`Unknown command journal entry: ${id}`);
	if (!COMMAND_TRANSITIONS[current.state].includes(state))
		throw new Error(`Invalid command transition: ${current.state} -> ${state}`);
	const now = new Date().toISOString();
	database
		.prepare("UPDATE command_journal SET state = ?, recovery_reason = ?, updated_at = ? WHERE id = ?")
		.run(state, reason ?? null, now, id);
	return readCommand(database, id)!;
}

export function openDurableStateStore(path: string): DurableStateStore {
	const database = new DatabaseSync(path);
	try {
		database.exec("BEGIN IMMEDIATE");
		createSchema(database);
		const version = readSchemaVersion(database);
		if (version > CURRENT_DURABLE_STATE_SCHEMA_VERSION) {
			database.exec("ROLLBACK");
			throw new Error(
				`Durable state database schema version ${version} is newer than this version (${CURRENT_DURABLE_STATE_SCHEMA_VERSION})`,
			);
		}
		if (version < 2) {
			const commandColumns = database.prepare('PRAGMA table_info("command_journal")').all() as Array<{
				name: string;
			}>;
			if (!commandColumns.some((column) => column.name === "recovery_reason"))
				database.exec("ALTER TABLE command_journal ADD COLUMN recovery_reason TEXT");
		}
		if (version < 3 && version > 0) {
			database.exec(`
				ALTER TABLE session_leases RENAME TO session_leases_v2;
				CREATE TABLE session_leases (
					session_id TEXT NOT NULL,
					owner_id TEXT NOT NULL,
					mode TEXT NOT NULL,
					expires_at TEXT NOT NULL,
					PRIMARY KEY (session_id, owner_id)
				);
				INSERT INTO session_leases (session_id, owner_id, mode, expires_at)
				SELECT session_id, owner_id, mode, expires_at FROM session_leases_v2;
				DROP TABLE session_leases_v2;
			`);
		}
		if (version < CURRENT_DURABLE_STATE_SCHEMA_VERSION) {
			database
				.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
				.run(CURRENT_DURABLE_STATE_SCHEMA_VERSION, new Date().toISOString());
		}
		database.exec("COMMIT");
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// Preserve the original migration error.
		}
		database.close();
		throw error;
	}

	return {
		schemaVersion: () => readSchemaVersion(database),
		tableNames: () => {
			const rows = database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all() as Array<{ name: string }>;
			return rows.map((row) => row.name);
		},
		columns: (tableName) => {
			if (!TABLES.includes(tableName as (typeof TABLES)[number]))
				throw new Error(`Unknown durable-state table: ${tableName}`);
			const rows = database.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>;
			return rows.map((row) => row.name);
		},
		beginCommand: ({ id = randomUUID(), sessionId, command }) => {
			const now = new Date().toISOString();
			database
				.prepare(
					"INSERT INTO command_journal (id, session_id, command, state, created_at, updated_at) VALUES (?, ?, ?, 'created', ?, ?)",
				)
				.run(id, sessionId, command, now, now);
			return readCommand(database, id)!;
		},
		transitionCommand: (id, state, reason) => {
			const current = readCommand(database, id);
			if (!current) throw new Error(`Unknown command journal entry: ${id}`);
			if (!COMMAND_TRANSITIONS[current.state].includes(state))
				throw new Error(`Invalid command transition: ${current.state} -> ${state}`);
			const now = new Date().toISOString();
			database
				.prepare("UPDATE command_journal SET state = ?, recovery_reason = ?, updated_at = ? WHERE id = ?")
				.run(state, reason ?? null, now, id);
			return readCommand(database, id)!;
		},
		getCommand: (id) => readCommand(database, id),
		recoverUnfinishedCommands: (reason = "daemon restarted before command completion") => {
			const rows = database
				.prepare("SELECT id FROM command_journal WHERE state IN ('created', 'running')")
				.all() as Array<{ id: string }>;
			return rows.map(({ id }) => {
				const current = readCommand(database, id)!;
				return current.state === "interrupted" ? current : transitionCommand(database, id, "interrupted", reason);
			});
		},
		recoverUnfinishedCommandsWithDiagnostics: (reason = "daemon restarted before command completion") => {
			const recoveredAt = new Date().toISOString();
			const rows = database
				.prepare("SELECT id, session_id, state FROM command_journal WHERE state IN ('created', 'running')")
				.all() as Array<{ id: string; session_id: string; state: "created" | "running" }>;
			return rows.map((row) => {
				transitionCommand(database, row.id, "interrupted", reason);
				return {
					commandId: row.id,
					sessionId: row.session_id,
					previousState: row.state,
					state: "interrupted" as const,
					reason,
					recoveredAt,
				};
			});
		},
		acquireLease: ({ sessionId, ownerId, mode, ttlMs }) => {
			if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Lease TTL must be positive");
			database.exec("BEGIN IMMEDIATE");
			try {
				database.prepare("DELETE FROM session_leases WHERE expires_at <= ?").run(new Date().toISOString());
				const active = readLeases(database, sessionId).filter((lease) => lease.ownerId !== ownerId);
				if (active.some((lease) => lease.mode === "exclusive") || (mode === "exclusive" && active.length > 0)) {
					throw new Error(`Session lease is held for ${sessionId}`);
				}
				const expiresAt = new Date(Date.now() + ttlMs).toISOString();
				database
					.prepare(
						"INSERT INTO session_leases (session_id, owner_id, mode, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, owner_id) DO UPDATE SET mode=excluded.mode, expires_at=excluded.expires_at",
					)
					.run(sessionId, ownerId, mode, expiresAt);
				database.exec("COMMIT");
				return readLeases(database, sessionId).find((lease) => lease.ownerId === ownerId)!;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
		releaseLease: (sessionId, ownerId) => {
			database.prepare("DELETE FROM session_leases WHERE session_id = ? AND owner_id = ?").run(sessionId, ownerId);
		},
		getLease: (sessionId) => readLease(database, sessionId),
		close: () => database.close(),
	};
}
