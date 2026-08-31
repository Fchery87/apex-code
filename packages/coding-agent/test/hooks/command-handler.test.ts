import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commandHookHandler } from "../../src/core/hooks/command-handler.ts";
import type { HookEventPayload } from "../../src/core/hooks/types.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

const payload: HookEventPayload = {
	type: "tool_call",
	toolName: "bash",
	toolCallId: "t1",
	input: { command: "git push" },
};

/** Write a helper script so the test command stays free of shell-quoting traps. */
function script(body: string): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-hook-command-"));
	directories.push(directory);
	const file = join(directory, "hook.mjs");
	writeFileSync(file, body);
	return `node "${file}"`;
}

// The POSIX paths of these tests (sh -c quoting) are covered on Linux/macOS;
// Windows coverage of the PowerShell spawn path is a separate concern.
describe.skipIf(process.platform === "win32")("command hook handler", () => {
	it("parses a JSON decision from stdout", async () => {
		const handler = commandHookHandler({
			type: "command",
			command: script(`process.stdout.write(JSON.stringify({ decision: "block", reason: "no pushes" }));`),
		});

		expect(await handler.execute(payload)).toEqual({
			ok: true,
			decision: { decision: "block", reason: "no pushes" },
		});
	});

	it("passes the event payload as JSON on stdin", async () => {
		const command = script(`
			let raw = "";
			process.stdin.on("data", (chunk) => (raw += chunk));
			process.stdin.on("end", () => {
				const payload = JSON.parse(raw);
				process.stdout.write(JSON.stringify(payload.toolName === "bash" ? { decision: "block", reason: "stdin seen" } : { decision: "allow" }));
			});
		`);
		const handler = commandHookHandler({ type: "command", command });

		expect(await handler.execute(payload)).toEqual({
			ok: true,
			decision: { decision: "block", reason: "stdin seen" },
		});
	});

	it("treats exit 0 with no output as no decision", async () => {
		const handler = commandHookHandler({ type: "command", command: script(`process.exit(0);`) });

		expect(await handler.execute(payload)).toEqual({ ok: true });
	});

	it("treats non-JSON stdout as no decision plus a warning, never as allow", async () => {
		const handler = commandHookHandler({ type: "command", command: script(`process.stdout.write("not json");`) });

		const outcome = await handler.execute(payload);
		expect(outcome).toEqual({ ok: true, warning: expect.stringContaining("not json") });
	});

	it("maps exit 2 to a block with stderr as the reason", async () => {
		const handler = commandHookHandler({
			type: "command",
			command: script(`process.stderr.write("protected branch");process.exit(2);`),
		});

		expect(await handler.execute(payload)).toEqual({
			ok: true,
			decision: { decision: "block", reason: "protected branch" },
		});
	});

	it("treats other nonzero exits as failure (fail closed downstream)", async () => {
		const handler = commandHookHandler({ type: "command", command: script(`process.exit(3);`) });

		expect(await handler.execute(payload)).toEqual({ ok: false, warning: expect.stringContaining("exit code 3") });
	});

	it("fails closed when the handler outlives its timeout", async () => {
		const handler = commandHookHandler({
			type: "command",
			command: script(`setInterval(() => {}, 1000);`),
			timeoutMs: 100,
		});

		expect(await handler.execute(payload)).toEqual({ ok: false, warning: expect.stringContaining("timed out") });
	});
});
