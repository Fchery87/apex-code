import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutionError } from "apex-code-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEvidenceSink } from "../../src/core/evidence.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestToolDefinition, createToolDefinition } from "../../src/core/tools/index.ts";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";

/**
 * Public-boundary tests for the standalone `test` tool's output capture
 * (spec 2026-09-01-tool-reliability-and-execution-budgets.md § 1).
 *
 * Every case drives the real tool through its execute boundary with real child
 * processes in a scratch directory. Fixtures are files rather than `node -e`
 * snippets so diagnostic text never appears in argv (which the status line
 * echoes) — that is what makes the silent-failure regression observable.
 */

const directories: string[] = [];

function scratchDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-test-tool-output-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeFixture(directory: string, name: string, body: string): string {
	const path = join(directory, name);
	writeFileSync(path, body, "utf-8");
	return path;
}

function createTool(cwd: string) {
	return wrapToolDefinition(createTestToolDefinition(cwd));
}

function contentText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

async function execute(
	cwd: string,
	params: { executable: string; args: string[]; timeout?: number },
	signal?: AbortSignal,
) {
	return await createTool(cwd).execute("test-call", params, signal);
}

describe("standalone test tool output capture", () => {
	it("reports a passing run with its captured stdout", async () => {
		const cwd = scratchDirectory();
		const fixture = writeFixture(cwd, "passes.cjs", `console.log("all 12 tests passed");\n`);
		const result = await execute(cwd, { executable: process.execPath, args: [fixture] });

		expect(result.details.outcome).toBe("exit");
		expect(result.details.exitCode).toBe(0);
		const text = contentText(result);
		expect(text).toContain("Test runner passed:");
		expect(text).toContain("all 12 tests passed");
	});

	it("returns failing-test diagnostic output instead of a bare status line", async () => {
		const cwd = scratchDirectory();
		const fixture = writeFixture(
			cwd,
			"fails.cjs",
			[
				`console.log("running suite");`,
				`console.error("AssertionError: expected 2 to equal 3");`,
				`console.error("  at sum (math.test.js:7:11)");`,
				`process.exitCode = 1;`,
			].join("\n"),
		);
		const result = await execute(cwd, { executable: process.execPath, args: [fixture] });

		expect(result.details.outcome).toBe("exit");
		expect(result.details.exitCode).toBe(1);
		const text = contentText(result);
		expect(text).toContain("Test runner failed (exit code 1):");
		expect(text).toContain("AssertionError: expected 2 to equal 3");
		expect(text).toContain("  at sum (math.test.js:7:11)");
	});

	it("preserves stdout and stderr as separate structured metadata and a sectioned view", async () => {
		const cwd = scratchDirectory();
		const fixture = writeFixture(
			cwd,
			"streams.cjs",
			[
				`process.stdout.write("stdout-identifier-7391\\n");`,
				`process.stderr.write("stderr-identifier-8452\\n");`,
			].join("\n"),
		);
		const result = await execute(cwd, { executable: process.execPath, args: [fixture] });

		expect(result.details.stdout.totalBytes).toBeGreaterThan(0);
		expect(result.details.stderr.totalBytes).toBeGreaterThan(0);
		expect(result.details.stdout.totalLines).toBe(1);
		expect(result.details.stderr.totalLines).toBe(1);
		expect(result.details.stdout.truncated).toBe(false);
		expect(result.details.stderr.truncated).toBe(false);
		expect(result.details.stdout.fullOutputPath).toBeUndefined();
		expect(result.details.stderr.fullOutputPath).toBeUndefined();

		const text = contentText(result);
		expect(text).toContain("stdout-identifier-7391");
		expect(text).toContain("stderr-identifier-8452");
		expect(text).toContain("--- stdout ---");
		expect(text).toContain("--- stderr ---");
		// Exact cross-stream ordering is not observable through separate pipes;
		// the view must say so rather than imply an ordering.
		expect(text).toContain("interleaved order");
		// Structured details are metadata only: raw stream text never enters them.
		const serialized = JSON.stringify(result.details);
		expect(serialized).not.toContain("stdout-identifier-7391");
		expect(serialized).not.toContain("stderr-identifier-8452");
	});

	it("bounds high-volume output, reports counts and truncation, and keeps the exit status authoritative", async () => {
		const cwd = scratchDirectory();
		const fixture = writeFixture(
			cwd,
			"volume.cjs",
			[
				`for (let i = 0; i < 3000; i++) console.log("v-" + i);`,
				`process.stderr.write("suite failed: 1 of 3000\\n");`,
				`process.exitCode = 1;`,
			].join("\n"),
		);
		const result = await execute(cwd, { executable: process.execPath, args: [fixture] });

		expect(result.details.exitCode).toBe(1);
		expect(result.details.outcome).toBe("exit");
		const stdout = result.details.stdout;
		expect(stdout.truncated).toBe(true);
		expect(stdout.truncatedBy).toBe("lines");
		expect(stdout.totalLines).toBe(3000);
		expect(stdout.shownLines).toBeLessThanOrEqual(2000);
		expect(stdout.totalBytes).toBeGreaterThan(stdout.shownBytes);
		expect(result.details.stderr.truncated).toBe(false);

		const text = contentText(result);
		expect(text).toContain("v-2999");
		expect(text).not.toContain("v-0\\n");
		expect(text).toContain("Full stdout output:");

		// The retained artifact holds the complete stream, and it exists.
		const artifactPath = stdout.fullOutputPath;
		expect(artifactPath).toBeTruthy();
		expect(existsSync(artifactPath!)).toBe(true);
		const retained = readFileSync(artifactPath!, "utf-8");
		expect(retained).toContain("v-0\n");
		expect(retained.split("\n").filter((line) => /^v-\d+$/.test(line)).length).toBe(3000);
	});

	it("bounds a single oversized line by bytes and reports byte truncation", async () => {
		const cwd = scratchDirectory();
		const fixture = writeFixture(
			cwd,
			"wide.cjs",
			[
				`const fs = require("node:fs");`,
				`const line = "x".repeat(90 * 1024) + "\\n";`,
				`fs.writeSync(1, line);`,
				`process.exit(0);`,
			].join("\n"),
		);
		const result = await execute(cwd, { executable: process.execPath, args: [fixture] });

		const stdout = result.details.stdout;
		expect(stdout.truncated).toBe(true);
		expect(stdout.truncatedBy).toBe("bytes");
		expect(stdout.totalLines).toBe(1);
		expect(stdout.shownBytes).toBeLessThanOrEqual(50 * 1024);
		expect(stdout.fullOutputPath).toBeTruthy();
	});

	it("decodes UTF-8 output split across chunk boundaries without replacement characters", async () => {
		const cwd = scratchDirectory();
		// "ok" is a 2-byte prefix before a stream of 3-byte characters, so the
		// reader's 64KiB pipe chunks split a multi-byte character mid-sequence.
		const expected = `ok${"€".repeat(200_000)}`;
		const fixture = writeFixture(
			cwd,
			"utf8.cjs",
			[
				`const fs = require("node:fs");`,
				`const payload = "ok" + "\\u20ac".repeat(200000);`,
				`const buf = Buffer.from(payload, "utf8");`,
				`let offset = 0;`,
				`while (offset < buf.length) offset += fs.writeSync(1, buf, offset, buf.length - offset);`,
			].join("\n"),
		);
		const result = await execute(cwd, { executable: process.execPath, args: [fixture] });

		expect(result.details.stdout.totalBytes).toBe(Buffer.byteLength(expected, "utf-8"));
		expect(result.details.stdout.totalLines).toBe(1);
		expect(contentText(result)).not.toContain("\uFFFD");
		const retained = readFileSync(result.details.stdout.fullOutputPath!, "utf-8");
		expect(retained).toBe(expected);
	});

	it("reports a timeout outcome with captured output and stops the runner", async () => {
		const cwd = scratchDirectory();
		const fixture = writeFixture(
			cwd,
			"hangs.cjs",
			[`console.log("output-before-hang-9931");`, `setTimeout(() => {}, 60000);`].join("\n"),
		);
		const startedAt = Date.now();
		const failure = await execute(cwd, {
			executable: process.execPath,
			args: [fixture],
			timeout: 1,
		}).catch((error) => error);

		expect(failure).toBeInstanceOf(ToolExecutionError);
		expect(failure.details.outcome).toBe("timeout");
		expect(failure.details.exitCode).toBeNull();
		expect(failure.message).toContain("timed out after 1");
		expect(failure.message).toContain("output-before-hang-9931");
		expect(Date.now() - startedAt).toBeLessThan(20_000);
	});

	it("rejects invalid timeout values before spawning", async () => {
		const cwd = scratchDirectory();
		const failure = await execute(cwd, {
			executable: process.execPath,
			args: ["-e", ""],
			timeout: -3,
		}).catch((error) => error);
		expect(failure).toBeInstanceOf(Error);
		expect(failure.message).toContain("Invalid timeout");
	});

	it("reports cancellation when the abort signal fires mid-run", async () => {
		const cwd = scratchDirectory();
		const fixture = writeFixture(cwd, "sleeps.cjs", `setTimeout(() => {}, 60000);`);
		const controller = new AbortController();
		const pending = execute(cwd, { executable: process.execPath, args: [fixture] }, controller.signal);
		setTimeout(() => controller.abort(), 300);
		const failure = await pending.catch((error) => error);

		expect(failure).toBeInstanceOf(ToolExecutionError);
		expect(failure.details.outcome).toBe("cancelled");
		expect(failure.message).toContain("aborted");
	});

	it("reports a signal-terminated runner with the signal name", async () => {
		if (process.platform === "win32") {
			return; // POSIX signal semantics only.
		}
		const cwd = scratchDirectory();
		const fixture = writeFixture(cwd, "selfkill.cjs", `process.kill(process.pid, "SIGTERM");`);
		const result = await execute(cwd, { executable: process.execPath, args: [fixture] });

		expect(result.details.outcome).toBe("signal");
		expect(result.details.exitCode).toBeNull();
		expect(result.details.signal).toBe("SIGTERM");
		expect(contentText(result)).toContain("terminated by SIGTERM");
	});

	it("reports a spawn failure with the underlying error", async () => {
		const cwd = scratchDirectory();
		const failure = await execute(cwd, {
			executable: "apex-code-missing-test-runner-binary",
			args: ["--version"],
		}).catch((error) => error);

		expect(failure).toBeInstanceOf(ToolExecutionError);
		expect(failure.details.outcome).toBe("spawn-failed");
		expect(failure.details.exitCode).toBeNull();
		expect(failure.details.spawnErrorMessage).toContain("ENOENT");
		expect(failure.message).toContain("could not start");
	});

	it("creates no artifact when output fits the bounded view", async () => {
		const cwd = scratchDirectory();
		const fixture = writeFixture(cwd, "small.cjs", `console.log("tiny");`);
		const result = await execute(cwd, { executable: process.execPath, args: [fixture] });

		expect(result.details.stdout.fullOutputPath).toBeUndefined();
		expect(result.details.stderr.fullOutputPath).toBeUndefined();
	});

	it("keeps full output out of evidence records and the session ledger", async () => {
		const workspace = scratchDirectory();
		const fixture = writeFixture(
			workspace,
			"fails-loudly.cjs",
			[`console.error("AssertionError: secret-diagnostic-text-4417");`, `process.exit(1);`].join("\n"),
		);
		const definition = createToolDefinition("test", workspace);
		const result = await wrapToolDefinition(definition).execute("call", {
			executable: process.execPath,
			args: [fixture],
		});

		const records = definition.contract.evidence.capture({ executable: process.execPath, args: [fixture] }, result);
		const serialized = JSON.stringify(records);
		expect(serialized).not.toContain("secret-diagnostic-text-4417");
		expect(serialized).not.toContain("fullOutputPath");
		expect(records[0]).toMatchObject({
			kind: "test",
			cwd: workspace,
			executable: process.execPath,
			argv: [fixture],
			exitCode: 1,
			outcome: "exit",
			outputTruncated: false,
		});

		// The durable sink validates the same boundary the ledger enforces: raw
		// stream text under this tool's record shape must be rejected, and the
		// accepted record must persist without the diagnostic text.
		const sessions = join(workspace, "sessions");
		const session = SessionManager.create(workspace, sessions);
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "running tests" }],
			api: "openai-responses",
			provider: "openai",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sink = new SessionEvidenceSink(session);
		expect(() => sink.record({ toolName: "test", records: records as never })).not.toThrow();
		const rawSession = readFileSync(session.getSessionFile()!, "utf-8");
		expect(rawSession).not.toContain("secret-diagnostic-text-4417");
	});
});
