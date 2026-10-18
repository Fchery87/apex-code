import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandJournalRecorder } from "../../src/core/durable-state/command-journal.ts";
import { openDurableStateStore } from "../../src/core/durable-state/sqlite.ts";
import { createBackgroundShellRegistry } from "../../src/core/tools/background-shell.ts";
import { OutputAccumulator } from "../../src/core/tools/output-accumulator.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "apex-bg-journal-"));
	tempDirs.push(dir);
	const databasePath = join(dir, "state.sqlite");
	const recorder = createCommandJournalRecorder(databasePath, "session-1");
	const registry = createBackgroundShellRegistry({ journal: recorder });
	const reader = openDurableStateStore(databasePath);
	return {
		registry,
		reader,
		recorder,
		databasePath,
		close: () => {
			recorder.close();
			reader.close();
		},
	};
}

function deferredExit() {
	let resolve!: (code: number | null) => void;
	const exited = new Promise<number | null>((done) => {
		resolve = done;
	});
	return { exited, finish: resolve };
}

describe("background command journal", () => {
	it("records the command as running before the process is launched", () => {
		const { registry, reader, close } = setup();
		try {
			const journalId = registry.beginJournal("sleep 30");
			expect(journalId).toBeDefined();
			expect(reader.getCommand(journalId!)).toMatchObject({ state: "running", sessionId: "session-1" });
			expect(reader.getCommand(journalId!)?.command).toBe("sleep 30");
		} finally {
			close();
		}
	});

	it("marks a command completed when it exits with status zero", async () => {
		const { registry, reader, close } = setup();
		try {
			const journalId = registry.beginJournal("echo ok");
			const exit = deferredExit();
			registry.launch({
				command: "echo ok",
				pid: undefined,
				output: new OutputAccumulator(),
				exited: exit.exited,
				journalId,
			});
			exit.finish(0);
			await exit.exited;
			await new Promise((done) => setImmediate(done));
			expect(reader.getCommand(journalId!)).toMatchObject({ state: "completed" });
		} finally {
			close();
		}
	});

	it("marks a killed command failed and records the kill as the reason", async () => {
		const { registry, reader, close } = setup();
		try {
			const journalId = registry.beginJournal("sleep 30");
			const exit = deferredExit();
			const handle = registry.launch({
				command: "sleep 30",
				pid: undefined,
				output: new OutputAccumulator(),
				exited: exit.exited,
				journalId,
			});
			registry.kill(handle);
			exit.finish(null);
			await exit.exited;
			await new Promise((done) => setImmediate(done));
			expect(reader.getCommand(journalId!)).toMatchObject({ state: "failed", recoveryReason: "killed by user" });
		} finally {
			close();
		}
	});

	it("refuses to begin a background command when the journal cannot record it", () => {
		const dir = mkdtempSync(join(tmpdir(), "apex-bg-journal-missing-"));
		tempDirs.push(dir);
		const recorder = createCommandJournalRecorder(join(dir, "missing", "state.sqlite"), "session-1");
		const registry = createBackgroundShellRegistry({ journal: recorder });
		expect(() => registry.beginJournal("sleep 30")).toThrow();
		recorder.close();
	});
});

describe("background command journal at the bash tool", () => {
	it.skipIf(process.platform === "win32")(
		"refuses a background command the journal cannot record, without running it",
		async () => {
			const { mkdirSync } = await import("node:fs");
			const { createBashToolDefinition } = await import("../../src/core/tools/bash.ts");
			const dir = mkdtempSync(join(tmpdir(), "apex-bg-refuse-"));
			tempDirs.push(dir);
			const marker = join(dir, "ran");
			mkdirSync(dir, { recursive: true });
			const unavailable = {
				begin: () => {
					throw new Error("sidecar unavailable");
				},
				finish: () => {},
				fail: () => {},
				recoverOrphans: () => [],
				close: () => {},
			};
			const registry = createBackgroundShellRegistry({ journal: unavailable });
			const definition = createBashToolDefinition(dir, { backgroundRegistry: registry });
			await expect(
				definition.execute(
					"t1",
					{ command: `touch ${marker}`, background: true } as never,
					undefined,
					undefined,
					undefined as never,
				),
			).rejects.toThrow(/Could not record the background command in the durable journal, so it was not started/);
			await new Promise((resolve) => setTimeout(resolve, 300));
			const { existsSync } = await import("node:fs");
			expect(existsSync(marker)).toBe(false);
		},
	);
});

describe("command journal releases the sidecar between operations", () => {
	it("leaves no open WAL behind after a command is journaled and finished", () => {
		// Windows cannot delete a database file while a handle is open, so a recorder that keeps
		// its connection open breaks the temp-directory cleanup in every test that runs a session.
		const dir = mkdtempSync(join(tmpdir(), "apex-bg-release-"));
		tempDirs.push(dir);
		const databasePath = join(dir, "state.sqlite");
		const recorder = createCommandJournalRecorder(databasePath, "session-1");
		const id = recorder.begin("echo done");
		recorder.finish(id, { exitCode: 0, killed: false });
		expect(existsSync(`${databasePath}-wal`)).toBe(false);
		rmSync(dir, { recursive: true, force: true });
		expect(existsSync(dir)).toBe(false);
	});
});

describe("background command journal after a failed launch", () => {
	it("records a launch that threw as failed, not as interrupted by a later recovery", () => {
		const { registry, reader, close } = setup();
		try {
			const journalId = registry.beginJournal("sleep 30");
			registry.failJournal(journalId!, new Error("Working directory does not exist"));
			expect(reader.getCommand(journalId!)).toMatchObject({ state: "failed" });
			expect(reader.getCommand(journalId!)?.recoveryReason).toMatch(/Working directory does not exist/);
		} finally {
			close();
		}
	});
});
