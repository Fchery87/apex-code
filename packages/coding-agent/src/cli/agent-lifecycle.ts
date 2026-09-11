/**
 * One-shot execution of the `agent <operation>` CLI subcommand family.
 *
 * The loaded session (and the permission gate its children derive authority from)
 * stays the sole owner of the child-run lifecycle: this module only translates a
 * parsed command into session-owned registry calls and prints a bounded report.
 * It never touches the registry directly and never answers a permission ask.
 */

import type { AgentSession } from "../core/agent-session.ts";
import type { ChildSessionStatus } from "../core/delegation/runtime.ts";
import type { AgentLifecycleCommand } from "./args.ts";

/** JSON-mode ceiling for a run result's output text (spec invariant 8: bounded summaries). */
const MAX_JSON_OUTPUT_CHARS = 2_000;
/** Text mode keeps each result to a single terminal line. */
const MAX_TEXT_OUTPUT_CHARS = 160;

export interface AgentLifecycleCommandOptions {
	/** `--mode json` prints one bounded JSON document; otherwise one line of text per result. */
	json: boolean;
}

function firstLineOf(text: string): string {
	const newline = text.indexOf("\n");
	return newline === -1 ? text : text.slice(0, newline);
}

function bound(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function observedStatus(session: AgentSession, childId: string): ChildSessionStatus | "unknown" {
	return session.listChildRuns().find((run) => run.handleId === childId)?.status ?? "unknown";
}

function reportStatus(
	operation: "send" | "resume" | "interrupt" | "close",
	childId: string,
	status: ChildSessionStatus | "unknown",
	options: AgentLifecycleCommandOptions,
): void {
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ operation, childId, status })}\n`);
		return;
	}
	const verb =
		operation === "send"
			? "Sent input to"
			: operation === "resume"
				? "Resumed"
				: operation === "interrupt"
					? "Interrupted"
					: "Closed";
	process.stdout.write(`${verb} child run ${childId}; status: ${status}\n`);
}

/**
 * Execute one parsed lifecycle operation against the session and return the process
 * exit code: 0 on success, 1 on unknown child id or any operation failure.
 *
 * `send` and `resume` report the observed post-operation status; `wait` retrieves
 * the run's latest settled turn, so after a follow-up or a resume it prints that
 * turn's output rather than the run's initial text.
 */
export async function runAgentLifecycleCommand(
	session: AgentSession,
	command: AgentLifecycleCommand,
	options: AgentLifecycleCommandOptions,
): Promise<number> {
	const { operation } = command;
	const childId = command.childId;
	try {
		switch (operation) {
			case "list": {
				const agents = session.listChildRuns();
				if (options.json) {
					process.stdout.write(`${JSON.stringify({ operation, agents })}\n`);
				} else if (agents.length === 0) {
					process.stdout.write("No child runs.\n");
				} else {
					for (const run of agents) {
						process.stdout.write(`${run.handleId} ${run.agentType} ${run.status}\n`);
					}
				}
				return 0;
			}
			case "wait": {
				if (childId === undefined) throw new Error('"agent wait" requires a child run id.');
				const result = await session.waitChildRun(childId);
				if (options.json) {
					const truncated = result.output.length > MAX_JSON_OUTPUT_CHARS;
					process.stdout.write(
						`${JSON.stringify({
							operation,
							childId,
							result: {
								handleId: result.handleId ?? childId,
								agentType: result.agentType,
								task: result.task,
								output: truncated ? result.output.slice(0, MAX_JSON_OUTPUT_CHARS) : result.output,
								outputTruncated: truncated,
							},
						})}\n`,
					);
				} else {
					const summary = bound(firstLineOf(result.output), MAX_TEXT_OUTPUT_CHARS);
					process.stdout.write(
						`${result.handleId ?? childId} ${result.agentType}${summary ? `: ${summary}` : ""}\n`,
					);
				}
				return 0;
			}
			case "send": {
				if (childId === undefined) throw new Error('"agent send" requires a child run id.');
				if (command.input === undefined) throw new Error('"agent send" requires input text.');
				await session.sendChildInput(childId, command.input);
				reportStatus(operation, childId, observedStatus(session, childId), options);
				return 0;
			}
			case "resume": {
				if (childId === undefined) throw new Error('"agent resume" requires a child run id.');
				reportStatus(operation, childId, await session.resumeChildRun(childId, command.input), options);
				return 0;
			}
			case "interrupt": {
				if (childId === undefined) throw new Error('"agent interrupt" requires a child run id.');
				session.interruptChildRun(childId);
				reportStatus(operation, childId, observedStatus(session, childId), options);
				return 0;
			}
			case "close": {
				if (childId === undefined) throw new Error('"agent close" requires a child run id.');
				session.closeChildRun(childId);
				reportStatus(operation, childId, observedStatus(session, childId), options);
				return 0;
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Error: ${message}\n`);
		return 1;
	}
}
