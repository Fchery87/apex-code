import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { CredentialPool, createCredentialIdentity } from "../../src/core/credential-pool.ts";
import { CURRENT_DURABLE_STATE_SCHEMA_VERSION, openDurableStateStore } from "../../src/core/durable-state/sqlite.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SqliteUsagePerformanceStore } from "../../src/core/usage-performance-store.ts";

function scratchDir(label: string): string {
	const dir = join(tmpdir(), `apex-usage-ledger-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function fakeClock(): () => number {
	let t = 0;
	return () => t++;
}

describe("production usage-performance wiring (task 8.1)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("records a durable, session-attributed sample through createAgentSessionServices with no store passed explicitly", async () => {
		const agentDir = scratchDir("wiring");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));

		const providerId = "usage-ledger-wiring";
		const faux = fauxProvider({ provider: providerId });
		faux.setResponses([fauxAssistantMessage([], { stopReason: "stop" })]);

		// Deliberately does NOT pass options.modelRuntime or any store: this is the
		// production path every real session takes.
		const services = await createAgentSessionServices({
			cwd: agentDir,
			agentDir,
			sessionId: "session-wiring-1",
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		services.modelRuntime.registerNativeProvider(faux.provider);
		await services.modelRuntime.refresh({ allowNetwork: false, providers: [providerId] });

		await services.modelRuntime.streamSimple(faux.getModel(), { messages: [] }).result();

		const store = new SqliteUsagePerformanceStore(join(agentDir, "state.sqlite"));
		cleanups.push(() => store.close());
		const samples = await store.list();

		expect(samples).toHaveLength(1);
		expect(samples[0]).toMatchObject({
			provider: providerId,
			model: faux.getModel().id,
			sessionId: "session-wiring-1",
			outcome: "success",
		});
		expect(typeof samples[0].ttftMs).toBe("number");
		expect(typeof samples[0].generationMs).toBe("number");
		expect(samples[0].usage).toBeDefined();
		expect(typeof samples[0].cost).toBe("number");
	});

	it("persists one row per credential-pool attempt, including a rotated-away failure", async () => {
		const agentDir = scratchDir("rotation");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));

		const providerId = "usage-ledger-rotation";
		const faux = fauxProvider({ provider: providerId });
		const primary = createCredentialIdentity("primary");
		const secondary = createCredentialIdentity("secondary");
		const pool = new CredentialPool({
			entries: [
				{ identity: primary, providerId },
				{ identity: secondary, providerId },
			],
		});
		const respond: FauxResponseFactory = (_context, options) =>
			options?.apiKey === "secondary-key"
				? fauxAssistantMessage([], { stopReason: "stop" })
				: fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Too Many Requests" });
		faux.setResponses([respond, respond]);

		const store = new SqliteUsagePerformanceStore(join(agentDir, "state.sqlite"), "session-rotation-1");
		cleanups.push(() => store.close());

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
			credentialPool: pool,
			resolveCredentialPoolAuth: (identity) =>
				identity === primary ? { apiKey: "primary-key" } : { apiKey: "secondary-key" },
			usagePerformanceStore: store,
			performanceClock: fakeClock(),
		});
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: [providerId] });

		const message = await runtime.streamSimple(faux.getModel(), { messages: [] }).result();
		expect(message.stopReason).toBe("stop");

		const samples = await store.list();
		expect(samples).toHaveLength(2);
		expect(samples[0]).toMatchObject({
			sessionId: "session-rotation-1",
			outcome: "error",
			failureKind: "rate_limited",
		});
		expect(samples[1]).toMatchObject({ sessionId: "session-rotation-1", outcome: "success" });
	});

	it("migrates a version-3 database to version 4, preserving unrelated tables and dropping usage_totals", () => {
		const agentDir = scratchDir("migration");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		const path = join(agentDir, "state.sqlite");

		// Build a v3 fixture by hand, seeded with data in the tables migration must
		// not touch, plus a legacy-shaped model_performance row and a usage_totals
		// row that must not survive the migration.
		const seed = new DatabaseSync(path);
		seed.exec(`
			CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
			CREATE TABLE command_journal (
				id TEXT PRIMARY KEY, session_id TEXT NOT NULL, command TEXT NOT NULL,
				state TEXT NOT NULL, recovery_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
			);
			CREATE TABLE session_leases (
				session_id TEXT NOT NULL, owner_id TEXT NOT NULL, mode TEXT NOT NULL, expires_at TEXT NOT NULL,
				PRIMARY KEY (session_id, owner_id)
			);
			CREATE TABLE usage_totals (
				session_id TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL DEFAULT 0,
				output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
				cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0
			);
			CREATE TABLE model_performance (
				id INTEGER PRIMARY KEY, provider TEXT NOT NULL, model_id TEXT NOT NULL,
				ttft_ms REAL, generation_ms REAL, sampled_at TEXT NOT NULL
			);
			CREATE TABLE cache_entries (key TEXT PRIMARY KEY, value BLOB NOT NULL, expires_at TEXT);
			INSERT INTO schema_migrations (version, applied_at) VALUES (3, '2026-01-01T00:00:00.000Z');
			INSERT INTO command_journal (id, session_id, command, state, created_at, updated_at)
				VALUES ('cmd-1', 'sess-1', 'echo hi', 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
			INSERT INTO session_leases (session_id, owner_id, mode, expires_at)
				VALUES ('sess-1', 'owner-1', 'exclusive', '2099-01-01T00:00:00.000Z');
			INSERT INTO usage_totals (session_id, input_tokens, cost) VALUES ('sess-1', 100, 0.5);
			INSERT INTO model_performance (provider, model_id, ttft_ms, generation_ms, sampled_at)
				VALUES ('acme', 'acme-large', 120, 480, '2026-01-01T00:00:00.000Z');
		`);
		seed.close();

		const store = openDurableStateStore(path);
		cleanups.push(() => store.close());

		expect(store.schemaVersion()).toBe(CURRENT_DURABLE_STATE_SCHEMA_VERSION);
		expect(store.schemaVersion()).toBeGreaterThanOrEqual(4);
		expect(store.tableNames()).not.toContain("usage_totals");

		const modelPerformanceColumns = store.columns("model_performance");
		for (const column of [
			"session_id",
			"role",
			"credential_identity",
			"outcome",
			"failure_kind",
			"input_tokens",
			"output_tokens",
			"cache_read_tokens",
			"cache_write_tokens",
			"cost",
		]) {
			expect(modelPerformanceColumns).toContain(column);
		}

		// Unrelated pre-existing data survived the migration untouched.
		expect(store.getCommand("cmd-1")).toMatchObject({ sessionId: "sess-1", state: "completed" });
		expect(store.getLease("sess-1")).toMatchObject({ ownerId: "owner-1", mode: "exclusive" });
	});

	it("prunes rows older than its retention window on open, leaving recent rows alone", async () => {
		const agentDir = scratchDir("retention");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		const path = join(agentDir, "state.sqlite");

		const oldSample = {
			timestamp: Date.now() - 200 * 24 * 60 * 60 * 1000, // 200 days ago
			provider: "acme",
			model: "acme-large",
			outcome: "success" as const,
			ttftMs: 10,
			generationMs: 20,
		};
		const recentSample = {
			timestamp: Date.now() - 1000,
			provider: "acme",
			model: "acme-large",
			outcome: "success" as const,
			ttftMs: 10,
			generationMs: 20,
		};

		// Seed both rows through a store whose own construction-time prune runs
		// before either record() call, so both land regardless of age.
		const seeder = new SqliteUsagePerformanceStore(path);
		await seeder.record(oldSample);
		await seeder.record(recentSample);
		seeder.close();

		// A fresh store, opened with a 90-day retention window, prunes on open.
		const store = new SqliteUsagePerformanceStore(path, undefined, 90);
		cleanups.push(() => store.close());
		const samples = await store.list();

		expect(samples).toHaveLength(1);
		expect(samples[0].timestamp).toBe(recentSample.timestamp);
	});

	it("degrades to a runtime diagnostic instead of throwing when the ledger cannot be opened", async () => {
		const agentDir = scratchDir("degradation");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));

		// state.sqlite exists as a directory, not a file: DatabaseSync reliably
		// fails to open it, without relying on platform-specific permission bits.
		mkdirSync(join(agentDir, "state.sqlite"));

		const providerId = "usage-ledger-degradation";
		const faux = fauxProvider({ provider: providerId });
		faux.setResponses([fauxAssistantMessage([], { stopReason: "stop" })]);

		const services = await createAgentSessionServices({
			cwd: agentDir,
			agentDir,
			sessionId: "session-degradation-1",
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "warning",
				message: expect.stringContaining("Usage/cost recording unavailable"),
			}),
		);

		// The turn itself is unaffected by the ledger being unavailable.
		services.modelRuntime.registerNativeProvider(faux.provider);
		await services.modelRuntime.refresh({ allowNetwork: false, providers: [providerId] });
		const message = await services.modelRuntime.streamSimple(faux.getModel(), { messages: [] }).result();
		expect(message.stopReason).toBe("stop");
	});

	it("tolerates two stores concurrently open against the same database path", async () => {
		const agentDir = scratchDir("concurrent");
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		const path = join(agentDir, "state.sqlite");

		// Simulates two CLI invocations against one agent directory: both open
		// the same durable-state database independently, interleaving writes.
		const storeA = new SqliteUsagePerformanceStore(path, "session-concurrent-a");
		const storeB = new SqliteUsagePerformanceStore(path, "session-concurrent-b");
		cleanups.push(
			() => storeA.close(),
			() => storeB.close(),
		);

		const base = { provider: "acme", model: "acme-large", outcome: "success" as const, ttftMs: 5, generationMs: 5 };
		await Promise.all([
			storeA.record({ ...base, timestamp: Date.now() }),
			storeB.record({ ...base, timestamp: Date.now() }),
			storeA.record({ ...base, timestamp: Date.now() }),
			storeB.record({ ...base, timestamp: Date.now() }),
		]);

		const seenViaA = await storeA.list();
		expect(seenViaA).toHaveLength(4);
		expect(seenViaA.filter((s) => s.sessionId === "session-concurrent-a")).toHaveLength(2);
		expect(seenViaA.filter((s) => s.sessionId === "session-concurrent-b")).toHaveLength(2);
	});
});
