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
		for (const table of store.tableNames()) {
			const columns = store.columns(table);
			expect(columns).not.toContain("api_key");
			expect(columns).not.toContain("token");
			expect(columns).not.toContain("access_token");
			expect(columns).not.toContain("refresh_token");
		}
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

	it("journals commands before execution and recovers unfinished work", () => {
		const store = openDurableStateStore(createDatabasePath());
		const created = store.beginCommand({ id: "cmd-1", sessionId: "session-1", command: "test" });
		expect(created.state).toBe("created");
		expect(store.transitionCommand("cmd-1", "running").state).toBe("running");
		const recovered = store.recoverUnfinishedCommands("process restarted");
		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toMatchObject({ id: "cmd-1", state: "interrupted", recoveryReason: "process restarted" });
		expect(store.recoverUnfinishedCommands()).toEqual([]);
		expect(() => store.transitionCommand("cmd-1", "completed")).toThrow(/Invalid command transition/);
		store.close();
	});

	it("rejects invalid journal transitions and duplicate command IDs", () => {
		const store = openDurableStateStore(createDatabasePath());
		store.beginCommand({ id: "cmd-1", sessionId: "session-1", command: "test" });
		expect(() => store.transitionCommand("cmd-1", "completed")).toThrow(/Invalid command transition/);
		expect(() => store.transitionCommand("missing", "running")).toThrow(/Unknown command/);
		expect(() => store.beginCommand({ id: "cmd-1", sessionId: "session-1", command: "test" })).toThrow();
		store.close();
	});

	it("enforces renewable exclusive and shared session leases", () => {
		const store = openDurableStateStore(createDatabasePath());
		store.acquireLease({ sessionId: "s", ownerId: "a", mode: "exclusive", ttlMs: 10_000 });
		expect(() => store.acquireLease({ sessionId: "s", ownerId: "b", mode: "shared", ttlMs: 10_000 })).toThrow(
			/lease is held/,
		);
		store.releaseLease("s", "a");
		const lease = store.acquireLease({ sessionId: "s", ownerId: "b", mode: "shared", ttlMs: 10_000 });
		expect(lease).toMatchObject({ sessionId: "s", ownerId: "b", mode: "shared" });
		store.close();
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
