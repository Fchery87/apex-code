/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentStopReason } from "apex-code-agent-core";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Terminal status of a non-interactive run, written as the `result` envelope in
 * JSON mode. The vocabulary is `AgentStopReason`'s own, rather than a second one
 * defined here, so the two cannot drift.
 */
type PrintRunStatus = AgentStopReason["kind"];

interface PrintRunOutcome {
	status: PrintRunStatus;
	/** What text mode prints to stderr. Empty when the run completed. */
	message: string;
}

/**
 * Resolve the run's terminal outcome.
 *
 * `agent_end`'s structured stop reason wins because the loop already applied its
 * documented precedence (aborted > error > budget > completed) to produce it. The
 * settled assistant message is only a fallback, for the runs that end without an
 * `agent_end` reaching this mode at all.
 */
function resolveRunOutcome(
	stopReason: AgentStopReason | undefined,
	settled: AssistantMessage | undefined,
): PrintRunOutcome {
	if (stopReason?.kind === "budget-exhausted") {
		const limit = stopReason.limit.replace(/-/g, " ");
		return {
			status: "budget-exhausted",
			message: `Run stopped: the ${limit} budget was exhausted (runBudget settings).`,
		};
	}
	const failed = (reason: "aborted" | "error"): PrintRunOutcome => ({
		status: reason,
		message: settled?.errorMessage || `Request ${reason}`,
	});
	const completed: PrintRunOutcome = { status: "completed", message: "" };

	// A stop reason answers the question by itself, including when it says the run
	// completed. Reading the settled message in that case would let one left over
	// from an earlier failed turn outrank what the loop concluded.
	if (stopReason !== undefined) {
		return stopReason.kind === "aborted" || stopReason.kind === "error" ? failed(stopReason.kind) : completed;
	}
	if (settled?.stopReason === "aborted" || settled?.stopReason === "error") {
		return failed(settled.stopReason);
	}
	return completed;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];
	// Structured terminal outcome of the last run (spec 2026-09-01-tool-reliability-
	// and-execution-budgets.md); surfaced in this mode's native form below.
	let lastStopReason: AgentStopReason | undefined;

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_end") {
				lastStopReason = event.stopReason;
			}
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		unsubscribeBackpressure =
			mode === "json"
				? session.agent.subscribe(async () => {
						await waitForRawStdoutBackpressure();
					})
				: undefined;
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		// The outcome is resolved once, for every mode. Deciding it inside the text
		// branch is what let a failed `--mode json` run exit 0: the stream carried the
		// error and the exit code reported success.
		const lastMessage = session.state.messages[session.state.messages.length - 1];
		const outcome = resolveRunOutcome(
			lastStopReason,
			lastMessage?.role === "assistant" ? (lastMessage as AssistantMessage) : undefined,
		);
		exitCode = outcome.status === "completed" ? 0 : 1;

		if (mode === "json") {
			writeRawStdout(`${JSON.stringify({ type: "result", status: outcome.status })}\n`);
		} else if (outcome.status === "completed") {
			if (lastMessage?.role === "assistant") {
				for (const content of (lastMessage as AssistantMessage).content) {
					if (content.type === "text") {
						writeRawStdout(`${content.text}\n`);
					}
				}
			}
		} else {
			console.error(outcome.message);
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
