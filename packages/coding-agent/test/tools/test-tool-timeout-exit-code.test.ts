import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestToolDefinition } from "../../src/core/tools/index.ts";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";

// Reproduce windows forced-termination semantics on every platform: killing
// the runner tree ends the child as a normal exit with code 1 and no signal —
// exactly what taskkill /F produces on the windows CI runner. The public
// contract must not surface that artifact as the run's exit code.
vi.mock("../../src/utils/shell.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/utils/shell.ts")>();
	return {
		...actual,
		killProcessTree: (pid: number) => {
			process.kill(pid, "SIGTERM");
		},
	};
});

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "apex-test-tool-timeout-"));
});

afterEach(() => {
	rmSync(scratch, { force: true, recursive: true });
});

function createTool(cwd: string) {
	return wrapToolDefinition(createTestToolDefinition(cwd));
}

function writeFixture(cwd: string, name: string, body: string): string {
	const fixture = join(cwd, name);
	writeFileSync(fixture, body, "utf-8");
	return fixture;
}

/** Hangs forever until the runner kills the tree, then reports exit code 1. */
const HANGS_AND_EXITS_ONE = [
	`process.on("SIGTERM", () => process.exit(1));`,
	`console.log("output-before-hang-5501");`,
	`setTimeout(() => {}, 60000);`,
].join("\n");

describe("standalone test tool runner-stopped exit codes", () => {
	it("reports exitCode null for a timed-out run even when the kill produces an exit code", async () => {
		const fixture = writeFixture(scratch, "hangs.cjs", HANGS_AND_EXITS_ONE);
		const failure = await createTool(scratch)
			.execute("test-call", { executable: process.execPath, args: [fixture], timeout: 1 })
			.catch((error) => error);

		expect(failure).toBeInstanceOf(Error);
		expect(failure.details.outcome).toBe("timeout");
		expect(failure.details.exitCode).toBeNull();
		expect(failure.message).toContain("output-before-hang-5501");
	});

	it("reports exitCode null for a cancelled run even when the kill produces an exit code", async () => {
		const fixture = writeFixture(scratch, "hangs-cancelled.cjs", HANGS_AND_EXITS_ONE);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);

		const failure = await createTool(scratch)
			.execute("test-call", { executable: process.execPath, args: [fixture] }, controller.signal)
			.catch((error) => error);

		expect(failure).toBeInstanceOf(Error);
		expect(failure.details.outcome).toBe("cancelled");
		expect(failure.details.exitCode).toBeNull();
	}, 10_000);
});
