/**
 * LSP.2 — startup resolution and status-store wiring, exercised through the real
 * production seam (`createAgentSessionServices`), not just the pool/registry in
 * isolation.
 *
 * Per the spec's "Resolved configuration, ownership, and lifecycle" and the plan's
 * Task LSP.2 Red list ("missing binary, un-spawnable binary, server that never
 * reaches `initialized`"), a configured server that cannot resolve, spawn, or
 * initialize its cwd-root process within its timeout is a startup misconfiguration:
 * it produces a fatal, actionable diagnostic and does not silently degrade to a
 * partially-working session. These tests prove that behavior end-to-end, prove the
 * diagnostic names the failing binary (not just the bare underlying error), prove a
 * sibling server that *did* start cleanly is disposed rather than orphaned when
 * startup as a whole fails, and prove `AgentSessionServices.lspStatus` is actually
 * populated with real state transitions during a real session, not just inspectable
 * in isolation (`test/lsp/status.test.ts` covers `LspStatusStore` alone).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function scratchDir(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `apex-lsp-services-${label}-`));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

const GOOD_STUB = join(import.meta.dirname, "../fixtures/lsp-stub-server.mjs");

/** A server that spawns fine but never answers `initialize` -- distinct from and not a modification of the shared stub. */
function writeHangingStub(dir: string): string {
	const path = join(dir, "hanging-stub.mjs");
	writeFileSync(path, "setInterval(() => {}, 60_000);\n");
	return path;
}

function methods(logPath: string): string[] {
	return readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line).method)
		.filter((method): method is string => typeof method === "string");
}

const RESOURCE_LOADER_OPTIONS = { noSkills: true, noPromptTemplates: true, noThemes: true } as const;

describe("createAgentSessionServices LSP startup", () => {
	test("an unresolvable configured binary fails fast with a diagnostic naming the binary and lookup path", async () => {
		const cwd = scratchDir("missing-binary");
		const settingsManager = SettingsManager.inMemory({
			lsp: {
				broken: {
					command: "apex-code-definitely-does-not-exist-xyz",
					languages: [{ languageId: "text", extensions: [".zzz"] }],
				},
			},
		});

		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			settingsManager,
			resourceLoaderOptions: RESOURCE_LOADER_OPTIONS,
		});
		cleanups.push(() => services.close());

		const error = services.diagnostics.find((diagnostic) => diagnostic.type === "error");
		expect(error?.message).toContain("apex-code-definitely-does-not-exist-xyz");
		expect(error?.message).toMatch(/PATH/);
		expect(services.lspConfigured).toBe(false);
	});

	test("a server that never reaches initialized fails startup fast, names the server, and disposes the sibling that did start", async () => {
		const cwd = scratchDir("partial-failure");
		const logPath = join(cwd, "server.jsonl");
		const hangingStub = writeHangingStub(cwd);

		const settingsManager = SettingsManager.inMemory({
			lsp: {
				good: {
					command: process.execPath,
					args: [GOOD_STUB],
					languages: [{ languageId: "typescript", extensions: [".good"] }],
				},
				bad: {
					command: process.execPath,
					args: [hangingStub],
					languages: [{ languageId: "text", extensions: [".bad"] }],
					// Short and well within the 100-120000ms bound (registry.ts) -- the
					// hanging stub never responds, so this always times out; it is not a
					// race against the good server's near-instant handshake.
					initializationTimeoutMs: 100,
				},
			},
		});

		// createAgentSessionServices spawns every configured server in one pool with
		// one shared, inherited environment (LSP settings never accept per-server env
		// overrides), so the shared stub's log path is set on the whole test process.
		const previousLog = process.env.APEX_LSP_STUB_LOG;
		process.env.APEX_LSP_STUB_LOG = logPath;
		try {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: cwd,
				settingsManager,
				resourceLoaderOptions: RESOURCE_LOADER_OPTIONS,
			});
			cleanups.push(() => services.close());

			// Fatal, not silently degraded: the whole app startup fails per the spec.
			const error = services.diagnostics.find((diagnostic) => diagnostic.type === "error");
			expect(error).toBeDefined();
			// Actionable: names the failing server id and its resolved binary, not just
			// the bare "initialize timed out" the client itself would report.
			expect(error?.message).toContain("bad");
			expect(error?.message).toContain(process.execPath);
			expect(error?.message).toMatch(/timed out/);

			expect(services.lspConfigured).toBe(false);
			expect(services.lspPool).toBeDefined();

			// The good server must have been cleanly shut down (shutdown/exit sent),
			// not merely orphaned, once the pool as a whole failed to start -- proving
			// createAgentSessionServices disposes a partially-started pool rather than
			// discarding it while its successfully-spawned children are still running.
			await expect.poll(() => methods(logPath)).toEqual(expect.arrayContaining(["shutdown", "exit"]));

			// The status store recorded the good server reaching ready and the bad
			// server degrading -- real transitions from a real startup, not a fixed
			// snapshot.
			const states = services.lspStatus.list();
			expect(states.some((status) => status.serverId === "good" && status.state === "ready")).toBe(true);
			expect(states.some((status) => status.serverId === "bad" && status.state === "degraded")).toBe(true);
		} finally {
			if (previousLog === undefined) delete process.env.APEX_LSP_STUB_LOG;
			else process.env.APEX_LSP_STUB_LOG = previousLog;
		}
	});

	test("lspStatus records real starting-to-ready transitions for a healthy startup", async () => {
		const cwd = scratchDir("status-wiring");
		const logPath = join(cwd, "server.jsonl");

		const settingsManager = SettingsManager.inMemory({
			lsp: {
				typescript: {
					command: process.execPath,
					args: [GOOD_STUB],
					languages: [{ languageId: "typescript", extensions: [".ts"] }],
				},
			},
		});

		const previousLog = process.env.APEX_LSP_STUB_LOG;
		process.env.APEX_LSP_STUB_LOG = logPath;
		try {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: cwd,
				settingsManager,
				resourceLoaderOptions: RESOURCE_LOADER_OPTIONS,
			});
			cleanups.push(() => services.close());

			expect(services.diagnostics.some((diagnostic) => diagnostic.type === "error")).toBe(false);
			expect(services.lspConfigured).toBe(true);

			const relevant = services.lspStatus.list().filter((status) => status.serverId === "typescript");
			expect(relevant.map((status) => status.state)).toEqual(["starting", "ready"]);
			const root = relevant[0]?.root;
			expect(root).toBeDefined();
			expect(services.lspStatus.latest("typescript", root as string)).toMatchObject({ state: "ready" });
			expect(services.lspStatus.totalCount).toBeGreaterThanOrEqual(2);
		} finally {
			if (previousLog === undefined) delete process.env.APEX_LSP_STUB_LOG;
			else process.env.APEX_LSP_STUB_LOG = previousLog;
		}
	});
});
