import { spawn } from "node:child_process";
import type { AgentTool } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import type { ApexToolDefinition, PermissionSpec } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const testSchema = Type.Object({
	executable: Type.String({ description: "Test runner executable, for example npm, npx, or pytest" }),
	args: Type.Array(Type.String(), {
		description: "Arguments passed directly to the test runner; never a shell command",
	}),
});

export type TestToolInput = Static<typeof testSchema>;

export interface TestRunDetails {
	cwd: string;
	executable: string;
	argv: string[];
	exitCode: number | null;
}

export interface TestOperationResult {
	exitCode: number | null;
}

export interface TestOperations {
	run(input: { executable: string; argv: string[]; cwd: string; signal?: AbortSignal }): Promise<TestOperationResult>;
}

const defaultOperations: TestOperations = {
	async run({ executable, argv, cwd, signal }) {
		if (signal?.aborted) throw new Error("Operation aborted");
		const child = spawn(executable, argv, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout?.resume();
		child.stderr?.resume();
		const abort = () => child.kill();
		if (signal) signal.addEventListener("abort", abort, { once: true });
		try {
			const exitCode = await waitForChildProcess(child);
			return { exitCode };
		} finally {
			if (signal) signal.removeEventListener("abort", abort);
		}
	},
};

export function createTestPermissionSpec(): PermissionSpec<typeof testSchema> {
	return {
		defaultBehavior: "ask",
		matches: (ruleContent, params) => ruleContent === JSON.stringify(params),
		describe: (ruleContent) => `Run test command: ${ruleContent}`,
		ruleForCall: (params) => JSON.stringify(params),
	};
}

export interface TestToolOptions {
	operations?: TestOperations;
}

/** Runs an argv-based test runner and returns its exit status as source-level evidence. */
export function createTestToolDefinition(
	cwd: string,
	options?: TestToolOptions,
): ApexToolDefinition<typeof testSchema, TestRunDetails> {
	const operations = options?.operations ?? defaultOperations;
	return {
		name: "test",
		label: "test",
		description:
			"Run a test executable with direct argv arguments. A non-zero exit code is reported as a test failure.",
		parameters: testSchema,
		contract: {
			capabilities: new Set(["exec"]),
			permission: createTestPermissionSpec(),
			context: { resultRecoverable: false, deferSchema: false },
			evidence: {
				emits: new Set(["test"]),
				capture: (_params, result) => [{ kind: "test", ...result.details }],
			},
		},
		async execute(_toolCallId, input, signal) {
			const observed = await operations.run({ executable: input.executable, argv: input.args, cwd, signal });
			const details: TestRunDetails = { ...observed, cwd, executable: input.executable, argv: [...input.args] };
			const status = details.exitCode === 0 ? "passed" : `failed (exit code ${details.exitCode ?? "unknown"})`;
			return {
				content: [{ type: "text", text: `Test runner ${status}: ${input.executable} ${input.args.join(" ")}` }],
				details,
			};
		},
	};
}

export function createTestTool(cwd: string, options?: TestToolOptions): AgentTool<typeof testSchema, TestRunDetails> {
	return wrapToolDefinition(createTestToolDefinition(cwd, options));
}
