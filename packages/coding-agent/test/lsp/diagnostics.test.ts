import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LspDiagnostics } from "../../src/core/lsp/diagnostics.ts";
import { LspPool } from "../../src/core/lsp/pool.ts";
import { type LspSettings, resolveLspRegistry } from "../../src/core/lsp/registry.ts";

const temporaryDirectories: string[] = [];
const diagnosticsServices: LspDiagnostics[] = [];
const pools: LspPool[] = [];

/**
 * The default has to cover a real child process spawn plus the LSP handshake before
 * the first publish can arrive, because `afterMutation` starts the server on demand.
 * The old 100ms covered none of that and only passed on fast Linux runners; Windows
 * CI spent longer than the whole budget just spawning node, and the publish-path
 * tests then read the timeout as `status: "unavailable"`. Cases that assert the
 * timeout itself pass their own short budget -- that number is their subject, and it
 * must not double as the budget for cases that need the publish to land.
 */
function createDiagnostics(
	mode: "stale-then-exact" | "many" | "none",
	timeoutMs = 10_000,
): {
	diagnostics: LspDiagnostics;
	logPath: string;
	sourcePath: string;
} {
	const workspace = mkdtempSync(join(tmpdir(), "apex-lsp-diagnostics-test-"));
	temporaryDirectories.push(workspace);
	const logPath = join(workspace, "server.jsonl");
	const sourcePath = join(workspace, "index.ts");
	writeFileSync(sourcePath, "const value: string = 1;\n");
	const settings: LspSettings = {
		test: {
			command: process.execPath,
			args: [join(import.meta.dirname, "../fixtures/lsp-stub-server.mjs")],
			languages: [{ languageId: "typescript", extensions: [".ts"] }],
			diagnosticsTimeoutMs: timeoutMs,
		},
	};
	const pool = new LspPool(resolveLspRegistry(settings, { workspace }), {
		env: {
			...process.env,
			APEX_LSP_STUB_LOG: logPath,
			APEX_LSP_STUB_TEXT_DOCUMENT_SYNC: "full",
			APEX_LSP_STUB_DIAGNOSTICS: mode,
		},
	});
	const diagnostics = new LspDiagnostics(pool);
	pools.push(pool);
	diagnosticsServices.push(diagnostics);
	return { diagnostics, logPath, sourcePath };
}

function methods(logPath: string): string[] {
	return readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line).method)
		.filter((method): method is string => typeof method === "string");
}

afterEach(async () => {
	await Promise.allSettled(diagnosticsServices.splice(0).map((diagnostics) => diagnostics.dispose()));
	await Promise.allSettled(pools.splice(0).map((pool) => pool.dispose()));
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("LspDiagnostics", () => {
	test("returns only a publish for the exact synchronized document version", async () => {
		const { diagnostics, logPath, sourcePath } = createDiagnostics("stale-then-exact");

		await expect(diagnostics.afterMutation(sourcePath)).resolves.toEqual({
			status: "ok",
			serverId: "test",
			truncated: false,
			diagnostics: [
				{
					message: "diagnostic for version 1",
					range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
					severity: 1,
				},
			],
		});
		expect(methods(logPath)).toContain("textDocument/didOpen");
	});

	test("reports disposed without inventing a server id", async () => {
		const { diagnostics, sourcePath } = createDiagnostics("none");
		await diagnostics.dispose();

		await expect(diagnostics.afterMutation(sourcePath)).resolves.toEqual({
			status: "unavailable",
			unavailableKind: "disposed",
			reason: "diagnostics are disposed",
		});
	});

	test("classifies a path with no matching server without inventing a server id", async () => {
		const { diagnostics, sourcePath } = createDiagnostics("none");
		const unmatchedPath = join(sourcePath, "..", "notes.txt");
		writeFileSync(unmatchedPath, "plain text\n");

		await expect(diagnostics.afterMutation(unmatchedPath)).resolves.toEqual({
			status: "unavailable",
			unavailableKind: "no-server",
			reason: "no language server configured for path",
		});
	});

	test("returns unavailable rather than clean when the server does not publish", async () => {
		const { diagnostics, sourcePath } = createDiagnostics("none", 100);

		await expect(diagnostics.afterMutation(sourcePath)).resolves.toEqual({
			status: "unavailable",
			serverId: "test",
			unavailableKind: "timed-out",
			reason: "timed out after 100ms",
		});
	});

	test("reports when a server publish exceeds the diagnostic retention bound", async () => {
		const { diagnostics, sourcePath } = createDiagnostics("many");

		const outcome = await diagnostics.afterMutation(sourcePath);

		expect(outcome).toMatchObject({ status: "ok", serverId: "test", truncated: true });
		if (outcome.status === "ok") expect(outcome.diagnostics).toHaveLength(1_000);
	});
});
