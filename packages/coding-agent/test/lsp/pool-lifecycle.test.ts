import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LspPool } from "../../src/core/lsp/pool.ts";
import { type LspSettings, resolveLspRegistry } from "../../src/core/lsp/registry.ts";

const temporaryDirectories: string[] = [];
const pools: LspPool[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-lsp-pool-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

/** Mirrors registry.ts's `canonical()` -- see the identical helper in registry.test.ts. */
function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function createPool(workspace: string, logPath: string): LspPool {
	const settings: LspSettings = {
		test: {
			command: process.execPath,
			args: [join(import.meta.dirname, "../fixtures/lsp-stub-server.mjs")],
			languages: [{ languageId: "typescript", extensions: [".ts"] }],
		},
	};
	const pool = new LspPool(resolveLspRegistry(settings, { workspace }), {
		env: { ...process.env, APEX_LSP_STUB_LOG: logPath },
	});
	pools.push(pool);
	return pool;
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
	await Promise.allSettled(pools.splice(0).map((pool) => pool.dispose()));
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("LspPool lifecycle", () => {
	test("eagerly starts each configured server and tears it down once", async () => {
		const workspace = temporaryDirectory();
		const logPath = join(workspace, "server.jsonl");
		const pool = createPool(workspace, logPath);

		await pool.start();
		await pool.dispose();
		await pool.dispose();

		expect(methods(logPath)).toEqual(["initialize", "initialized", "shutdown", "exit"]);
		expect(pool.status()).toEqual([{ serverId: "test", root: canonical(workspace), state: "closed", attempts: 1 }]);
	});

	test("restarts only on demand and disables a server-root after three total attempts", async () => {
		const workspace = temporaryDirectory();
		const logPath = join(workspace, "server.jsonl");
		const sourcePath = join(workspace, "index.ts");
		writeFileSync(sourcePath, "export {};\n");
		const pool = createPool(workspace, logPath);
		await pool.start();

		for (let attempt = 1; attempt <= 3; attempt++) {
			const connection = await pool.acquire(sourcePath);
			expect(connection?.selection.root).toBe(canonical(workspace));
			connection?.client.notify("test/exit");
			await expect.poll(() => pool.status()[0]?.state).toBe(attempt === 3 ? "disabled" : "degraded");
			if (attempt < 3) {
				const initializeCount = methods(logPath).filter((method) => method === "initialize").length;
				await new Promise<void>((resolve) => setTimeout(resolve, 20));
				expect(methods(logPath).filter((method) => method === "initialize")).toHaveLength(initializeCount);
			}
		}

		await expect(pool.acquire(sourcePath)).rejects.toThrow("disabled after 3 attempts");
		expect(methods(logPath).filter((method) => method === "initialize")).toHaveLength(3);
		expect(pool.status()[0]).toMatchObject({ serverId: "test", state: "disabled", attempts: 3 });
	});
});
