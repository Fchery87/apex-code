import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DurableStateDaemon } from "../../src/core/durable-state/daemon.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function createDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "apex-daemon-"));
	tempDirs.push(dir);
	return dir;
}

describe("DurableStateDaemon", () => {
	it("recovers an interrupted command after a daemon restart", async () => {
		const path = join(createDir(), "state.sqlite");
		const first = new DurableStateDaemon({ databasePath: path, daemonId: "first" });
		first.attach({ sessionId: "s", clientId: "client", mode: "exclusive", ttlMs: 10_000 });
		first.beginMutation({ id: "cmd", sessionId: "s", clientId: "client", command: "append" });
		first.dispose();
		const restarted = new DurableStateDaemon({ databasePath: path, daemonId: "second" });
		expect(restarted.recoveryDiagnostics).toMatchObject([{ commandId: "cmd", state: "interrupted" }]);
		expect(restarted.getCommand("cmd")?.state).toBe("interrupted");
		restarted.dispose();
	});

	it("recovers a command after its daemon process is killed", async () => {
		const databasePath = join(createDir(), "state.sqlite");
		const daemonModule = pathToFileURL(join(process.cwd(), "src/core/durable-state/daemon.ts")).href;
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import { DurableStateDaemon } from ${JSON.stringify(daemonModule)}; const daemon = new DurableStateDaemon({ databasePath: ${JSON.stringify(databasePath)}, daemonId: "child" }); daemon.attach({ sessionId: "s", clientId: "client", mode: "exclusive", ttlMs: 60000 }); daemon.beginMutation({ id: "killed", sessionId: "s", clientId: "client", command: "append" }); console.log("ready"); setInterval(() => {}, 1000);`,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.stdout.once("data", (chunk) =>
				chunk.toString().includes("ready") ? resolve() : reject(new Error("Daemon did not become ready")),
			);
		});
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.once("close", () => resolve()));
		const restarted = new DurableStateDaemon({ databasePath, daemonId: "restarted" });
		expect(restarted.recoveryDiagnostics).toMatchObject([{ commandId: "killed", state: "interrupted" }]);
		expect(restarted.getCommand("killed")?.state).toBe("interrupted");
		restarted.dispose();
	});

	it("allows two shared clients to attach while rejecting their mutations", () => {
		const daemon = new DurableStateDaemon({
			databasePath: join(createDir(), "state.sqlite"),
			daemonId: "daemon",
			cwd: process.cwd(),
		});
		expect(daemon.provenance.revision).toMatch(/^[0-9a-f]{40}$/);
		expect(daemon.attach({ sessionId: "session", clientId: "a", mode: "shared", ttlMs: 10_000 }).mode).toBe("shared");
		expect(daemon.attach({ sessionId: "session", clientId: "b", mode: "shared", ttlMs: 10_000 }).mode).toBe("shared");
		expect(() => daemon.beginMutation({ sessionId: "session", clientId: "a", command: "append" })).toThrow(
			/exclusive lease/,
		);
		daemon.dispose();
	});

	it("rejects a second client mutation and leaves JSONL ordered", async () => {
		const dir = createDir();
		const session = SessionManager.create(dir, join(dir, "sessions"), { id: "session" });
		const daemon = new DurableStateDaemon({ databasePath: join(dir, "state.sqlite"), daemonId: "daemon" });
		daemon.attach({ sessionId: "session", clientId: "a", mode: "exclusive", ttlMs: 10_000 });
		expect(() => daemon.attach({ sessionId: "session", clientId: "b", mode: "exclusive", ttlMs: 10_000 })).toThrow(
			/lease is held/,
		);
		await daemon.runMutation({ sessionId: "session", clientId: "a", command: "append" }, async () => {
			session.appendMessage({ role: "user", content: "one", timestamp: 1 });
		});
		expect(session.getEntries().map((entry) => entry.id)).toHaveLength(1);
		expect(daemon.getCommandCount()).toBe(1);
		daemon.dispose();
	});
});
