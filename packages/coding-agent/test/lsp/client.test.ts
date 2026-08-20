import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { LspClient } from "../../src/core/lsp/client.ts";

const temporaryDirectories: string[] = [];
const clients: LspClient[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-lsp-client-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function readLog(path: string): Array<{ method?: string }> {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

afterEach(async () => {
	await Promise.allSettled(clients.splice(0).map((client) => client.dispose()));
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("LspClient", () => {
	test("queues requests until the initialize handshake completes", async () => {
		const workspace = temporaryDirectory();
		const logPath = join(workspace, "server.jsonl");
		const client = new LspClient({
			command: process.execPath,
			args: [join(import.meta.dirname, "../fixtures/lsp-stub-server.mjs")],
			cwd: workspace,
			env: {
				...process.env,
				APEX_LSP_STUB_LOG: logPath,
				APEX_LSP_STUB_INITIALIZE_DELAY_MS: "25",
			},
		});
		clients.push(client);

		const starting = client.start();
		const response = client.request("test/echo", { value: "queued" });

		await expect(response).resolves.toEqual({ value: "queued" });
		await starting;
		expect(readLog(logPath).map(({ method }) => method)).toEqual(["initialize", "initialized", "test/echo"]);
	});

	test("correlates interleaved responses and cancels only the aborted request", async () => {
		const workspace = temporaryDirectory();
		const logPath = join(workspace, "server.jsonl");
		const client = new LspClient({
			command: process.execPath,
			args: [join(import.meta.dirname, "../fixtures/lsp-stub-server.mjs")],
			cwd: workspace,
			env: { ...process.env, APEX_LSP_STUB_LOG: logPath },
		});
		clients.push(client);
		await client.start();

		const controller = new AbortController();
		const slow = client.request("test/echo", { value: "slow", delayMs: 100 }, controller.signal);
		const slowResult = expect(slow).rejects.toThrow("cancelled by test");
		const fast = client.request("test/echo", { value: "fast", delayMs: 5 });
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort(new Error("cancelled by test"));

		await expect(fast).resolves.toEqual({ value: "fast" });
		await slowResult;
		expect(readLog(logPath).map(({ method }) => method)).toEqual([
			"initialize",
			"initialized",
			"test/echo",
			"test/echo",
			"$/cancelRequest",
		]);
	});

	test("shuts down gracefully and can be disposed more than once", async () => {
		const workspace = temporaryDirectory();
		const logPath = join(workspace, "server.jsonl");
		const client = new LspClient({
			command: process.execPath,
			args: [join(import.meta.dirname, "../fixtures/lsp-stub-server.mjs")],
			cwd: workspace,
			env: { ...process.env, APEX_LSP_STUB_LOG: logPath },
		});
		clients.push(client);
		await client.start();

		await client.dispose();
		await client.dispose();

		expect(readLog(logPath).map(({ method }) => method)).toEqual(["initialize", "initialized", "shutdown", "exit"]);
	});

	test("rejects current and future requests after the server exits", async () => {
		const workspace = temporaryDirectory();
		const client = new LspClient({
			command: process.execPath,
			args: [join(import.meta.dirname, "../fixtures/lsp-stub-server.mjs")],
			cwd: workspace,
		});
		clients.push(client);
		await client.start();

		client.notify("test/exit");
		await new Promise<void>((resolve) => setTimeout(resolve, 25));

		await expect(client.request("test/echo", { value: "too late" })).rejects.toThrow(
			"Language server exited before shutdown (code=43 signal=null)",
		);
		expect(() => client.notify("test/echo", { value: "too late" })).toThrow(
			"Language server exited before shutdown (code=43 signal=null)",
		);
	});

	test("answers server requests during initialization and publishes notifications", async () => {
		const workspace = temporaryDirectory();
		const logPath = join(workspace, "server.jsonl");
		const client = new LspClient({
			command: process.execPath,
			args: [join(import.meta.dirname, "../fixtures/lsp-stub-server.mjs")],
			cwd: workspace,
			env: {
				...process.env,
				APEX_LSP_STUB_LOG: logPath,
				APEX_LSP_STUB_INITIALIZE_REQUEST_METHOD: "workspace/configuration",
			},
		});
		clients.push(client);
		const notifications: unknown[] = [];
		const unsubscribe = client.onNotification((notification) => notifications.push(notification));

		await client.start();
		client.notify("test/publish", { uri: "file:///test.ts", version: 1, diagnostics: [] });
		await expect.poll(() => notifications.length).toBe(1);
		unsubscribe();

		const messages = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(messages[1]).toEqual({ jsonrpc: "2.0", id: 1000, result: [null] });
		expect(notifications).toEqual([
			{
				method: "textDocument/publishDiagnostics",
				params: { uri: "file:///test.ts", version: 1, diagnostics: [] },
			},
		]);
	});

	test("times out initialization and reaps the child", async () => {
		const workspace = temporaryDirectory();
		const client = new LspClient({
			command: process.execPath,
			args: [join(import.meta.dirname, "../fixtures/lsp-stub-server.mjs")],
			cwd: workspace,
			env: { ...process.env, APEX_LSP_STUB_INITIALIZE_DELAY_MS: "1000" },
			initializationTimeoutMs: 20,
		});
		clients.push(client);

		await expect(client.start()).rejects.toThrow("Language server initialize timed out");
		await expect(client.request("test/echo", {})).rejects.toThrow("Language server initialize timed out");
	});

	test("dispose during initialization is bounded and rejects queued work", async () => {
		const workspace = temporaryDirectory();
		const client = new LspClient({
			command: process.execPath,
			args: [join(import.meta.dirname, "../fixtures/lsp-stub-server.mjs")],
			cwd: workspace,
			env: { ...process.env, APEX_LSP_STUB_INITIALIZE_DELAY_MS: "1000" },
			initializationTimeoutMs: 5_000,
		});
		clients.push(client);
		const starting = client.start();
		const queued = client.request("test/echo", {});

		await client.dispose();
		await expect(starting).rejects.toThrow();
		await expect(queued).rejects.toThrow();
	});
});
