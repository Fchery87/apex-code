import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "apex-code-agent-core";
import { minimatch } from "minimatch";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { DelegationRuntimeOptions } from "../delegation/runtime.ts";
import { retrieveDelegationResult, runDelegation } from "../delegation/runtime.ts";
import type { ApexToolDefinition, EvidenceRecord } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const delegateSchema = Type.Union([
	Type.Object({
		agentType: Type.String({ description: "The type of subagent to delegate to." }),
		task: Type.String({ description: "The task to delegate." }),
		background: Type.Optional(
			Type.Boolean({ description: "Return a handle immediately instead of waiting for the child." }),
		),
	}),
	Type.Object({
		agentType: Type.String({ description: "The agent type that produced the background result." }),
		handle: Type.String({ description: "A background delegation handle returned by an earlier call." }),
	}),
]);

export type DelegateInput = Static<typeof delegateSchema>;

export interface DelegateDetails {
	agentType: string;
	task: string;
	output: string;
	handle?: string;
}

function formatDelegateCall(input: DelegateInput, theme: Theme): string {
	if ("handle" in input) {
		return `${theme.fg("toolTitle", theme.bold("delegate"))} ${theme.fg("accent", input.agentType)} · retrieve`;
	}
	const task = input.task.replace(/\s+/g, " ").trim();
	return `${theme.fg("toolTitle", theme.bold("delegate"))} ${theme.fg("accent", input.agentType)} · ${theme.fg("toolOutput", task)}`;
}

function formatDelegateResult(details: DelegateDetails, expanded: boolean, theme: Theme): string {
	if (expanded) return theme.fg("toolOutput", details.output);
	const lineCount = details.output ? details.output.split("\n").length : 0;
	return `${theme.fg("accent", details.agentType)} · ${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
}

/**
 * The delegation entry point (task 4.6's contract, task 5.2's execution). Runs a
 * real child through the injected `DelegationRuntimeOptions` -- capability ceiling,
 * derived permission store, and child-session construction all live behind that
 * injection (ADR 0008), matching the `todo_write`/`tool_schema` convention of
 * injecting collaborators rather than reaching for global state. Recursion
 * depth, artifact isolation, and real agent discovery are wired:
 * `../delegation/runtime.ts` bounds depth and roots per-child artifact
 * directories, and `../delegation/agents.ts` supplies production markdown
 * discovery through the injected resolver.
 */
export function createDelegateToolDefinition(
	runtime: DelegationRuntimeOptions,
): ApexToolDefinition<typeof delegateSchema, DelegateDetails> {
	return {
		name: "delegate",
		label: "delegate",
		description: "Delegate a task to a subagent.",
		parameters: delegateSchema,
		contract: {
			capabilities: new Set(["delegate"]),
			permission: {
				defaultBehavior: "ask",
				matches: (ruleContent, params) => minimatch(params.agentType, ruleContent),
				describe: (ruleContent) => `Delegate to agent types matching "${ruleContent}"`,
				ruleForCall: (params) => params.agentType,
			},
			context: { resultRecoverable: false, deferSchema: true },
			evidence: {
				emits: new Set(["workflow"]),
				capture: (params): EvidenceRecord[] =>
					"task" in params
						? [{ kind: "workflow", agentType: params.agentType, task: params.task }]
						: [{ kind: "workflow", agentType: params.agentType, handle: params.handle }],
			},
		},
		async execute(_toolCallId, input: DelegateInput): Promise<AgentToolResult<DelegateDetails>> {
			const result =
				"task" in input
					? await runDelegation(runtime, input.agentType, input.task, { background: input.background })
					: await retrieveDelegationResult(runtime, input.handle, input.agentType);
			return {
				content: [{ type: "text", text: result.output }],
				details: {
					agentType: result.agentType,
					task: result.task,
					output: result.output,
					handle: result.handleId,
				},
			};
		},
		renderCall(input, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatDelegateCall(input, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatDelegateResult(result.details, options.expanded, theme));
			return text;
		},
	};
}

export function createDelegateTool(runtime: DelegationRuntimeOptions) {
	return wrapToolDefinition(createDelegateToolDefinition(runtime));
}
