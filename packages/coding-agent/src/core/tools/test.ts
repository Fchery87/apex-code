import { spawn } from "node:child_process";
import { type AgentTool, ToolExecutionError } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import type { ApexToolDefinition, PermissionSpec, TestProcessOutcome } from "./contract.ts";
import { OutputAccumulator, type OutputSnapshot } from "./output-accumulator.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { formatSize, type TruncationResult } from "./truncate.ts";

export type { TestProcessOutcome } from "./contract.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	}
	return timeoutMs;
}

const testSchema = Type.Object({
	executable: Type.String({ description: "Test runner executable, for example npm, npx, or pytest" }),
	args: Type.Array(Type.String(), {
		description: "Arguments passed directly to the test runner; never a shell command",
	}),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type TestToolInput = Static<typeof testSchema>;

/**
 * Bounded capture of one output stream. `content` is the model-facing tail;
 * `truncation` carries shown/total counts; `fullOutputPath` references the
 * artifact holding the complete stream when the view omitted output.
 */
export interface TestStreamCapture {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

/** Structured per-stream metadata. Raw stream text never enters these details. */
export interface TestStreamDetails {
	totalBytes: number;
	totalLines: number;
	shownBytes: number;
	shownLines: number;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	fullOutputPath?: string;
}

export interface TestOperationResult {
	exitCode: number | null;
	/**
	 * How the run actually ended. Omitted classifications are derived from
	 * `exitCode`: a code means the run exited on its own; runner-stopped runs
	 * (`timeout`, `cancelled`) always report null, otherwise the run ended on a
	 * `signal`.
	 */
	outcome?: TestProcessOutcome;
	/** Signal name when the runner was terminated by one, otherwise null. */
	signal?: string | null;
	/** Underlying error message when the runner could not be spawned. */
	spawnErrorMessage?: string;
	stdout?: TestStreamCapture;
	stderr?: TestStreamCapture;
}

export interface TestOperations {
	run(input: {
		executable: string;
		argv: string[];
		cwd: string;
		signal?: AbortSignal;
		timeout?: number;
	}): Promise<TestOperationResult>;
}

const defaultOperations: TestOperations = {
	async run({ executable, argv, cwd, signal, timeout }) {
		const timeoutMs = resolveTimeoutMs(timeout);
		if (signal?.aborted) {
			return { exitCode: null, outcome: "cancelled", signal: null };
		}

		const stdout = new OutputAccumulator({ tempFilePrefix: "apex-code-test-stdout" });
		const stderr = new OutputAccumulator({ tempFilePrefix: "apex-code-test-stderr" });
		const child = spawn(executable, argv, {
			cwd,
			// Detached on POSIX so killProcessTree can take down the whole runner
			// process group on timeout or cancellation (mirrors the bash tool).
			detached: process.platform !== "win32",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (child.pid) trackDetachedChildPid(child.pid);

		let exitCode: number | null = null;
		let exitSignal: string | null = null;
		let spawnError: Error | undefined;
		let timedOut = false;
		let aborted = false;
		let acceptingOutput = true;

		child.once("exit", (code, signalName) => {
			exitCode = code;
			exitSignal = typeof signalName === "string" ? signalName : null;
		});
		child.once("error", (error) => {
			spawnError = error;
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			if (acceptingOutput) stdout.append(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (acceptingOutput) stderr.append(chunk);
		});

		const onAbort = () => {
			aborted = true;
			if (child.pid) killProcessTree(child.pid);
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		let timeoutHandle: NodeJS.Timeout | undefined;
		if (timeoutMs !== undefined) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				if (child.pid) killProcessTree(child.pid);
			}, timeoutMs);
		}

		try {
			await waitForChildProcess(child);
		} catch (error) {
			spawnError ??= error instanceof Error ? error : new Error(String(error));
		} finally {
			acceptingOutput = false;
			if (child.pid) untrackDetachedChildPid(child.pid);
			if (timeoutHandle) clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);
		}

		stdout.finish();
		stderr.finish();
		const stdoutCapture = await closeAfterSnapshot(stdout);
		const stderrCapture = await closeAfterSnapshot(stderr);

		if (spawnError) {
			return {
				exitCode: null,
				outcome: "spawn-failed",
				signal: exitSignal,
				spawnErrorMessage: spawnError.message,
				stdout: stdoutCapture,
				stderr: stderrCapture,
			};
		}
		if (aborted) {
			// The runner stopped the process, so the run has no meaningful exit
			// code. A forced kill reports the OS artifact (a signal on POSIX,
			// exit code 1 under taskkill on Windows); mirrors the bash tool,
			// which reports exitCode null for interrupted runs.
			return {
				exitCode: null,
				outcome: "cancelled",
				signal: exitSignal,
				stdout: stdoutCapture,
				stderr: stderrCapture,
			};
		}
		if (timedOut) {
			return {
				exitCode: null,
				outcome: "timeout",
				signal: exitSignal,
				stdout: stdoutCapture,
				stderr: stderrCapture,
			};
		}
		if (exitCode !== null) {
			return { exitCode, outcome: "exit", signal: null, stdout: stdoutCapture, stderr: stderrCapture };
		}
		return { exitCode: null, outcome: "signal", signal: exitSignal, stdout: stdoutCapture, stderr: stderrCapture };
	},
};

async function closeAfterSnapshot(accumulator: OutputAccumulator): Promise<TestStreamCapture> {
	const snapshot = accumulator.snapshot({ persistIfTruncated: true });
	await accumulator.closeTempFile();
	return toStreamCapture(snapshot);
}

function toStreamCapture(snapshot: OutputSnapshot): TestStreamCapture {
	return {
		content: snapshot.content,
		truncation: snapshot.truncation,
		...(snapshot.fullOutputPath ? { fullOutputPath: snapshot.fullOutputPath } : {}),
	};
}

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

export interface TestRunDetails {
	cwd: string;
	executable: string;
	argv: string[];
	/** How the run actually ended. */
	outcome: TestProcessOutcome;
	exitCode: number | null;
	/** Signal name when the runner was terminated by one, otherwise null. */
	signal: string | null;
	/** Underlying error message when the runner could not be spawned. */
	spawnErrorMessage?: string;
	/** Per-stream bounded metadata; raw output lives in the result text and artifacts only. */
	stdout: TestStreamDetails;
	stderr: TestStreamDetails;
}

function deriveOutcome(observed: TestOperationResult): TestProcessOutcome {
	return observed.outcome ?? (observed.exitCode !== null ? "exit" : "signal");
}

function streamDetails(capture: TestStreamCapture | undefined): TestStreamDetails {
	const truncation = capture?.truncation;
	return {
		totalBytes: truncation?.totalBytes ?? 0,
		totalLines: truncation?.totalLines ?? 0,
		shownBytes: truncation?.outputBytes ?? 0,
		shownLines: truncation?.outputLines ?? 0,
		truncated: truncation?.truncated ?? false,
		truncatedBy: truncation?.truncatedBy ?? null,
		...(capture?.fullOutputPath ? { fullOutputPath: capture.fullOutputPath } : {}),
	};
}

function formatStatusLine(details: TestRunDetails, timeoutSeconds: number | undefined): string {
	const invocation = `${details.executable} ${details.argv.join(" ")}`;
	switch (details.outcome) {
		case "exit": {
			const status = details.exitCode === 0 ? "passed" : `failed (exit code ${details.exitCode ?? "unknown"})`;
			return `Test runner ${status}: ${invocation}`;
		}
		case "signal":
			return `Test runner failed (terminated by ${details.signal ?? "an unknown signal"}): ${invocation}`;
		case "timeout":
			return `Test runner timed out after ${timeoutSeconds ?? "unknown"} seconds: ${invocation}`;
		case "cancelled":
			return `Test runner aborted: ${invocation}`;
		case "spawn-failed":
			return `Test runner could not start (${details.spawnErrorMessage ?? "unknown error"}): ${invocation}`;
	}
}

function formatStreamSection(label: string, capture: TestStreamCapture | undefined): string | undefined {
	if (!capture) return undefined;
	const truncation = capture.truncation;
	const notices: string[] = [];
	if (truncation.truncated) {
		notices.push(
			truncation.truncatedBy === "lines"
				? `${label} truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines`
				: `${label} truncated: showing last ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} (${formatSize(truncation.maxBytes)} limit)`,
		);
	}
	if (capture.fullOutputPath) {
		notices.push(`Full ${label.toLowerCase()} output: ${capture.fullOutputPath}`);
	}
	const header = `--- ${label.toLowerCase()} ---`;
	const body = capture.content.length > 0 ? capture.content : "(no output)";
	const parts = [header, body];
	if (notices.length > 0) parts.push(`[${notices.join(". ")}]`);
	return parts.join("\n");
}

function formatResultText(
	details: TestRunDetails,
	stdout: TestStreamCapture | undefined,
	stderr: TestStreamCapture | undefined,
	timeoutSeconds: number | undefined,
): string {
	const parts: string[] = [formatStatusLine(details, timeoutSeconds)];
	const stdoutSection = formatStreamSection("stdout", stdout);
	if (stdoutSection) parts.push("", stdoutSection);
	const stderrSection = formatStreamSection("stderr", stderr);
	if (stderrSection) parts.push("", stderrSection);
	if (stdout?.content && stderr?.content) {
		parts.push("", "[Note: stdout and stderr appear as separate sections; their interleaved order was not captured]");
	}
	return parts.join("\n");
}

/** Runs an argv-based test runner and returns bounded captured output as source-level evidence. */
export function createTestToolDefinition(
	cwd: string,
	options?: TestToolOptions,
): ApexToolDefinition<typeof testSchema, TestRunDetails> {
	const operations = options?.operations ?? defaultOperations;
	return {
		name: "test",
		label: "test",
		description:
			"Run a test executable with direct argv arguments. A non-zero exit code is reported as a test failure. Returns bounded stdout and stderr output (full output is saved to a file when truncated), the process outcome, and byte/line counts. Optionally provide a timeout in seconds.",
		parameters: testSchema,
		contract: {
			capabilities: new Set(["exec"]),
			permission: createTestPermissionSpec(),
			context: { resultRecoverable: false, deferSchema: false },
			evidence: {
				emits: new Set(["test"]),
				capture: (_params, result) => {
					const details = result.details;
					if (!details) return [];
					return [
						{
							kind: "test",
							cwd: details.cwd,
							executable: details.executable,
							argv: details.argv,
							exitCode: details.exitCode,
							outcome: details.outcome,
							outputTruncated: details.stdout.truncated || details.stderr.truncated,
						},
					];
				},
			},
		},
		async execute(_toolCallId, input, signal) {
			const observed = await operations.run({
				executable: input.executable,
				argv: input.args,
				cwd,
				signal,
				timeout: input.timeout,
			});
			const outcome = deriveOutcome(observed);
			const details: TestRunDetails = {
				cwd,
				executable: input.executable,
				argv: [...input.args],
				outcome,
				exitCode: observed.exitCode,
				signal: observed.signal ?? null,
				...(observed.spawnErrorMessage ? { spawnErrorMessage: observed.spawnErrorMessage } : {}),
				stdout: streamDetails(observed.stdout),
				stderr: streamDetails(observed.stderr),
			};
			const text = formatResultText(details, observed.stdout, observed.stderr, input.timeout);
			if (outcome === "cancelled" || outcome === "timeout" || outcome === "spawn-failed") {
				throw new ToolExecutionError<TestRunDetails>(text, details);
			}
			return {
				content: [{ type: "text", text }],
				details,
			};
		},
	};
}

export function createTestTool(cwd: string, options?: TestToolOptions): AgentTool<typeof testSchema, TestRunDetails> {
	return wrapToolDefinition(createTestToolDefinition(cwd, options));
}
