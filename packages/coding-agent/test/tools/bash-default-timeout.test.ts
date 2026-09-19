import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BashOperations,
	createBashToolDefinition,
	DEFAULT_BASH_TIMEOUT_SECONDS,
} from "../../src/core/tools/bash.ts";

/**
 * A call with no `timeout` ran unbounded, so a process waiting on stdin nothing will write,
 * or a network call with no timeout of its own, held the tool call open for the life of the
 * session. Nothing else in the loop distinguishes that from slow. ADR 0035.
 */
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function newCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "apex-bash-timeout-"));
	directories.push(cwd);
	return cwd;
}

type BashDefinition = ReturnType<typeof createBashToolDefinition>;

function recordingShell(cwd: string) {
	const seen: Array<number | undefined> = [];
	const operations: BashOperations = {
		exec: async (_command, _cwd, options) => {
			seen.push(options.timeout);
			return { exitCode: 0 };
		},
		spawnBackground: async () => ({ pid: undefined, exited: Promise.resolve(0) }),
	};
	return { definition: createBashToolDefinition(cwd, { operations }), seen };
}

function run(definition: BashDefinition, input: unknown): Promise<unknown> {
	return definition.execute("t", input as never, undefined, undefined, undefined as never) as Promise<unknown>;
}

describe("bash applies a default wall-clock timeout", () => {
	it("hands the backend the default when the call names no timeout", async () => {
		const { definition, seen } = recordingShell(newCwd());
		await run(definition, { command: "true" });
		// The literal, not the constant: comparing an absent default against itself passes.
		expect(seen).toEqual([3600]);
		expect(seen).toEqual([DEFAULT_BASH_TIMEOUT_SECONDS]);
	});

	it("uses one hour, the value ADR 0035 derived from the recorded suite runs", () => {
		expect(DEFAULT_BASH_TIMEOUT_SECONDS).toBe(3600);
	});

	it("stops telling the model there is no default", () => {
		const { definition } = recordingShell(newCwd());
		expect(definition.description).not.toMatch(/no default timeout/i);
	});

	it("still honors an explicit timeout, which is one of the two escape hatches", async () => {
		const { definition, seen } = recordingShell(newCwd());
		await run(definition, { command: "true", timeout: 5 });
		expect(seen).toEqual([5]);
	});

	it("names both escape hatches when it fires, so the kill is actionable", async () => {
		const cwd = newCwd();
		const operations: BashOperations = {
			exec: async () => {
				throw new Error("timeout:3600");
			},
			spawnBackground: async () => ({ pid: undefined, exited: Promise.resolve(0) }),
		};
		const definition = createBashToolDefinition(cwd, { operations });
		const message = await run(definition, { command: "sleep forever" }).then(
			() => "did not throw",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		expect(message).toMatch(/timed out after 3600 seconds/);
		expect(message).toMatch(/timeout/);
		expect(message).toMatch(/background/i);
	});

	it("still leaves a background launch unbounded, since it is the escape hatch", async () => {
		const { definition, seen } = recordingShell(newCwd());
		await run(definition, { command: "true", background: true });
		expect(seen).toEqual([]);
	});
});
