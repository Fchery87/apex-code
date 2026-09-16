import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateToolCall } from "../../src/core/permissions/gate.ts";
import { type BashOperations, createBashToolDefinition } from "../../src/core/tools/bash.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function newCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "apex-shell-operation-"));
	directories.push(cwd);
	return cwd;
}

type BashDefinition = ReturnType<typeof createBashToolDefinition>;
type BashExecuteResult = Awaited<ReturnType<BashDefinition["execute"]>>;

function run(definition: BashDefinition, id: string, input: unknown): Promise<BashExecuteResult> {
	return definition.execute(
		id,
		input as never,
		undefined,
		undefined,
		undefined as never,
	) as Promise<BashExecuteResult>;
}

function textOf(result: BashExecuteResult): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

function validate(definition: BashDefinition, args: unknown): unknown {
	return validateToolArguments(
		definition as never,
		{
			type: "toolCall",
			id: "boundary",
			name: definition.name,
			arguments: args as never,
		} as never,
	);
}

/**
 * A shell backend whose background launch never exits, so a handle stays live
 * for the whole test without spawning a real process.
 */
function stubbedShell(cwd: string) {
	const spawned: string[] = [];
	const operations: BashOperations = {
		exec: async () => ({ exitCode: 0 }),
		spawnBackground: async (command, _cwd, options) => {
			spawned.push(command);
			options.onData(Buffer.from("original output"));
			return { pid: undefined, exited: new Promise<number | null>(() => {}) };
		},
	};
	return { definition: createBashToolDefinition(cwd, { operations }), spawned };
}

async function launchHandle(definition: BashDefinition): Promise<string> {
	const launch = await run(definition, "launch", { command: "printf original", background: true });
	const handle = /handle (\S+)/.exec(textOf(launch))?.[1];
	if (!handle) throw new Error("launch did not return a handle");
	return handle;
}

function gateOptions(definition: BashDefinition) {
	const rules = [
		{ source: "session", behavior: "allow", toolName: "bash", ruleContent: "pwd" },
		{ source: "session", behavior: "deny", toolName: "bash", ruleContent: "background-handle" },
	];
	return {
		getContract: () => definition.contract,
		store: { snapshot: async () => ({ rules, errors: [] }) },
		getMode: () => "default",
	} as never;
}

describe("shell operation boundary", () => {
	it("does not let an allowed command smuggle a denied background kill past the gate", async () => {
		const { definition } = stubbedShell(newCwd());
		const handle = await launchHandle(definition);
		const options = gateOptions(definition);

		const pure = await evaluateToolCall("bash", validate(definition, { handle, kill: true }) as never, options);
		expect(pure.block).toBe(true);

		const mixed = await evaluateToolCall(
			"bash",
			validate(definition, { command: "pwd", handle, kill: true }) as never,
			options,
		);
		expect(mixed.block).toBe(true);
	});

	it("records the command that actually ran, not a command the call never executed", async () => {
		const { definition } = stubbedShell(newCwd());
		const handle = await launchHandle(definition);

		const params = validate(definition, { command: "pwd", handle });
		let evidence: Array<{ command?: string }> = [];
		try {
			const result = await run(definition, "mixed", params);
			evidence = definition.contract.evidence.capture(params as never, result as never) as never;
		} catch {
			// Rejecting the ambiguous call outright also satisfies this contract:
			// nothing ran, so nothing can be misreported.
			return;
		}
		expect(evidence[0]?.command).not.toBe("pwd");
	});

	it("agrees across preview, rule, execution, and evidence for one kill call", async () => {
		const { definition } = stubbedShell(newCwd());
		const handle = await launchHandle(definition);
		const params = { handle, kill: true };
		const { permission, evidence } = definition.contract;

		expect(permission.previewCall?.(params as never)).toEqual({
			kind: "summary",
			lines: [`Kill background shell command ${handle}`],
		});
		expect(permission.ruleForCall?.(params as never)).toBe("background-handle");

		const result = await run(definition, "kill", params);
		expect(textOf(result)).toContain("kill signal sent");

		const captured = evidence.capture(params as never, result as never) as Array<{ command?: string }>;
		expect(captured[0]?.command).toBe("printf original");
	});

	it("rejects the recorded placeholder shape instead of silently running the command", async () => {
		const { definition, spawned } = stubbedShell(newCwd());
		await expect(
			run(definition, "placeholder", { background: false, command: "printf leaked", handle: "", kill: true }),
		).rejects.toThrow();
		expect(spawned).toHaveLength(0);
	});
});
