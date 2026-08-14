import { minimatch } from "minimatch";
import { Type, type Static } from "typebox";
import type { AgentToolResult } from "apex-code-agent-core";
import type { DelegationRuntimeOptions } from "../delegation/runtime.ts";
import { runDelegation } from "../delegation/runtime.ts";
import type { ApexToolDefinition, EvidenceRecord } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const delegateSchema = Type.Object({
	agentType: Type.String({ description: "The type of subagent to delegate to." }),
	task: Type.String({ description: "The task to delegate." }),
});

export type DelegateInput = Static<typeof delegateSchema>;

export interface DelegateDetails {
	agentType: string;
	task: string;
	output: string;
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
				matches: (ruleContent, params) => minimatch(params.agentType, ruleContent),
				describe: (ruleContent) => `Delegate to agent types matching "${ruleContent}"`,
				ruleForCall: (params) => params.agentType,
			},
			context: { resultRecoverable: false, deferSchema: true },
			evidence: {
				emits: new Set(["workflow"]),
				capture: (params): EvidenceRecord[] => [{ kind: "workflow", agentType: params.agentType, task: params.task }],
			},
		},
		async execute(_toolCallId, { agentType, task }: DelegateInput): Promise<AgentToolResult<DelegateDetails>> {
			const result = await runDelegation(runtime, agentType, task);
			return {
				content: [{ type: "text", text: result.output }],
				details: { agentType: result.agentType, task: result.task, output: result.output },
			};
		},
	};
}

export function createDelegateTool(runtime: DelegationRuntimeOptions) {
	return wrapToolDefinition(createDelegateToolDefinition(runtime));
}
