import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_DURABLE_STATE_SCHEMA_VERSION, openDurableStateStore } from "../../src/core/durable-state/sqlite.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createDatabasePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-durable-state-"));
	tempDirs.push(dir);
	return join(dir, "state.sqlite");
}

describe("durable state SQLite schema", () => {
	it("creates the versioned sidecar schema without storing credentials", () => {
		const store = openDurableStateStore(createDatabasePath());

		expect(store.schemaVersion()).toBe(CURRENT_DURABLE_STATE_SCHEMA_VERSION);
		expect(store.tableNames()).toEqual([
			"cache_entries",
			"command_journal",
			"daemon_metadata",
			"model_performance",
			"schema_migrations",
			"session_leases",
			"usage_totals",
		]);
		expect(store.columns("schema_migrations")).toEqual(["version", "applied_at"]);
		store.close();
	});

	it("reopens an existing database idempotently", () => {
		const path = createDatabasePath();
		const first = openDurableStateStore(path);
		first.close();

		const second = openDurableStateStore(path);
		expect(second.schemaVersion()).toBe(CURRENT_DURABLE_STATE_SCHEMA_VERSION);
		second.close();
	});

	it("keeps JSONL sessions readable when the sidecar is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-jsonl-"));
		tempDirs.push(dir);
		const sessions = join(dir, "sessions");
		const manager = SessionManager.create(dir, sessions, { id: "jsonl-only" });
		manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "world" }],
			api: "test",
			provider: "test",
			model: "small",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reopened = SessionManager.open(sessionFile, sessions);
		expect(reopened.getEntries()).toHaveLength(2);
		expect(reopened.buildSessionContext().messages).toHaveLength(2);
	});

	it("rejects a database newer than this binary", () => {
		const path = createDatabasePath();
		const database = new DatabaseSync(path);
		database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
		database
			.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
			.run(CURRENT_DURABLE_STATE_SCHEMA_VERSION + 1, new Date().toISOString());
		database.close();

		expect(() => openDurableStateStore(path)).toThrow(/newer than this version/);
	});
});
