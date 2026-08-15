import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestToolDefinition, createToolDefinition } from "../../src/core/tools/index.ts";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";

const directories: string[] = [];

function scratchDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-test-evidence-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("test runner source evidence", () => {
	it("is registered as an explicit first-party test surface", () => {
		expect(createToolDefinition("test", scratchDirectory()).name).toBe("test");
	});

	it("captures normalized executable, arguments, cwd, and an unsuccessful exit status", async () => {
		const cwd = scratchDirectory();
		const definition = createTestToolDefinition(cwd, {
			operations: { run: async () => ({ exitCode: 1, executable: "npm", argv: ["test", "--", "unit"] }) },
		});
		const params = { executable: "npm", args: ["test", "--", "unit"] };
		const result = await wrapToolDefinition(definition).execute("test-call", params);

		expect(result.details).toMatchObject({ exitCode: 1 });
		expect(definition.contract.evidence.capture(params, result)).toEqual([
			{ kind: "test", executable: "npm", argv: ["test", "--", "unit"], cwd, exitCode: 1 },
		]);
	});
	it("observes a real non-zero test-process result without treating it as an execution exception", async () => {
		const cwd = scratchDirectory();
		const definition = createTestToolDefinition(cwd);
		const params = { executable: process.execPath, args: ["-e", "process.exit(1)"] };
		const result = await wrapToolDefinition(definition).execute("real-nonzero", params);

		expect(result.details.exitCode).toBe(1);
		expect(definition.contract.evidence.capture(params, result)).toEqual([
			{ kind: "test", executable: process.execPath, argv: ["-e", "process.exit(1)"], cwd, exitCode: 1 },
		]);
	});
});
