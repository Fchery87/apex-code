import { DatabaseSync } from "node:sqlite";

/** Current schema for the daemon-owned durable-state sidecar. */
export const CURRENT_DURABLE_STATE_SCHEMA_VERSION = 1;

const TABLES = [
	"cache_entries",
	"command_journal",
	"daemon_metadata",
	"model_performance",
	"schema_migrations",
	"session_leases",
	"usage_totals",
] as const;

export interface DurableStateStore {
	schemaVersion(): number;
	tableNames(): string[];
	columns(tableName: string): string[];
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
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS session_leases (
			session_id TEXT PRIMARY KEY,
			owner_id TEXT NOT NULL,
			mode TEXT NOT NULL,
			expires_at TEXT NOT NULL
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
		close: () => database.close(),
	};
}
