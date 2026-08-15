import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutionError } from "apex-code-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";

const directories: string[] = [];

function scratchDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-bash-evidence-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bash source evidence", () => {
	it("captures normalized execution facts observed by the bash tool", async () => {
		const cwd = scratchDirectory();
		const definition = createBashToolDefinition(cwd, {
			operations: {
				exec: async () => ({ exitCode: 0, executable: "/bin/bash", argv: ["-c", "printf safe"] }),
			},
		});
		const params = { command: "printf safe" };
		const result = await wrapToolDefinition(definition).execute("call-1", params);

		expect(definition.contract.evidence.capture(params, result)).toEqual([
			{
				kind: "command",
				command: "printf safe",
				cwd,
				executable: "/bin/bash",
				argv: ["-c", "printf safe"],
				exitCode: 0,
			},
		]);
	});
	it("retains non-zero source facts on a structured execution error", async () => {
		const cwd = scratchDirectory();
		const definition = createBashToolDefinition(cwd, {
			operations: { exec: async () => ({ exitCode: 7, executable: "/bin/bash", argv: ["-c", "exit 7"] }) },
		});
		let error: unknown;
		try {
			await wrapToolDefinition(definition).execute("failed-call", { command: "exit 7" });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ToolExecutionError);
		expect(error).toMatchObject({
			details: { execution: { cwd, executable: "/bin/bash", argv: ["-c", "exit 7"], exitCode: 7 } },
		});
	});
});
