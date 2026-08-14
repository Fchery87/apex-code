import { minimatch } from "minimatch";
import { Type, type Static } from "typebox";
import type { AgentToolResult } from "apex-code-agent-core";
import type { ApexToolDefinition, EvidenceRecord } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const delegateSchema = Type.Object({
	agentType: Type.String({ description: "The type of subagent to delegate to." }),
	task: Type.String({ description: "The task to delegate." }),
});

export type DelegateInput = Static<typeof delegateSchema>;

/**
 * The delegation entry point's declared surface only (task 4.6). The roadmap
 * assigns subagent spawning, recursion depth guards, and artifact/worktree
 * isolation to Phase 5, which depends on `pi-subagents` primitives not yet
 * vendored -- this ships the contract, capability declaration, and rule grammar so
 * Phase 5 has a surface to enforce a ceiling against, and nothing more. `execute`
 * therefore never spawns a child; it fails loudly rather than silently no-oping,
 * the same posture `web_search` takes for its own not-yet-configured backend.
 */
export function createDelegateToolDefinition(): ApexToolDefinition<typeof delegateSchema, undefined> {
	return {
		name: "delegate",
		label: "delegate",
		description: "Delegate a task to a subagent. Entry point only -- execution ships in Phase 5.",
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
		async execute(_toolCallId, _params: DelegateInput): Promise<AgentToolResult<undefined>> {
			throw new Error(
				"delegate is an entry-point contract only in this phase; subagent execution is not implemented until Phase 5.",
			);
		},
	};
}

export function createDelegateTool() {
	return wrapToolDefinition(createDelegateToolDefinition());
}
