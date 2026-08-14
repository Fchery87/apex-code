import { minimatch } from "minimatch";
import { Type, type Static } from "typebox";
import type { AgentToolResult } from "apex-code-agent-core";
import type { DelegationRuntimeOptions } from "../delegation/runtime.ts";
import { retrieveDelegationResult, runDelegation } from "../delegation/runtime.ts";
import type { ApexToolDefinition, EvidenceRecord } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const delegateSchema = Type.Union([
	Type.Object({
		agentType: Type.String({ description: "The type of subagent to delegate to." }),
		task: Type.String({ description: "The task to delegate." }),
		background: Type.Optional(Type.Boolean({ description: "Return a handle immediately instead of waiting for the child." })),
	}),
	Type.Object({
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

/**
 * The delegation entry point (task 4.6's contract, task 5.2's execution). Runs a
 * real child through the injected `DelegationRuntimeOptions` -- capability ceiling,
 * derived permission store, and child-session construction all live behind that
 * injection (ADR 0008), matching the `todo_write`/`tool_schema` convention of
 * injecting collaborators rather than reaching for global state. Recursion depth
 * (task 5.3), artifact isolation (task 5.4), and real agent discovery (task 5.5,
 * replacing the resolver a test or caller injects here) are not yet wired.
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
				matches: (ruleContent, params) =>
					"agentType" in params
						? minimatch(params.agentType, ruleContent)
						: ruleContent === `handle:${params.handle}`,
				describe: (ruleContent) => `Delegate to agent types matching "${ruleContent}"`,
				ruleForCall: (params) => ("agentType" in params ? params.agentType : `handle:${params.handle}`),
			},
			context: { resultRecoverable: false, deferSchema: true },
			evidence: {
				emits: new Set(["workflow"]),
				capture: (params): EvidenceRecord[] =>
					"agentType" in params
						? [{ kind: "workflow", agentType: params.agentType, task: params.task }]
						: [],
			},
		},
		async execute(_toolCallId, input: DelegateInput): Promise<AgentToolResult<DelegateDetails>> {
			const result = "handle" in input
				? await retrieveDelegationResult(runtime, input.handle)
				: await runDelegation(runtime, input.agentType, input.task, { background: input.background });
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
	};
}

export function createDelegateTool(runtime: DelegationRuntimeOptions) {
	return wrapToolDefinition(createDelegateToolDefinition(runtime));
}
