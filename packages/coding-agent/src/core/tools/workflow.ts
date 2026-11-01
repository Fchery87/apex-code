import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import { formatHiddenLines } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { DelegationRuntimeOptions } from "../delegation/runtime.ts";
import { WORKFLOW_MIGRATION_MESSAGE } from "../delegation/workflow-run.ts";
import type { ApexToolDefinition, EvidenceRecord } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/** Legacy input is retained only to return an actionable migration refusal. */
const workflowSchema = Type.Object({
	script: Type.String({ description: "Legacy JavaScript source. Execution is disabled during migration." }),
	args: Type.Optional(Type.Unknown({ description: "Legacy workflow arguments. Execution is disabled." })),
	runId: Type.Optional(Type.String({ description: "Legacy run identifier. No replay state will be read." })),
	name: Type.Optional(Type.String({ description: "Legacy saved workflow name. Does not authorize execution." })),
});

export type WorkflowInput = Static<typeof workflowSchema>;

export interface WorkflowDetails {
	output: string;
	runId: string;
	calls: number;
	phases: { title: string; calls: number }[];
	warnings: string[];
}

function formatCall(input: WorkflowInput, theme: Theme): string {
	return `${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", input.name ?? "script")}`;
}

export function createWorkflowToolDefinition(
	_runtime: DelegationRuntimeOptions,
): ApexToolDefinition<typeof workflowSchema, WorkflowDetails> {
	return {
		name: "workflow",
		label: "workflow",
		description:
			"Workflow execution is disabled during migration to declarative JSON workflows. Legacy scripts cannot run.",
		parameters: workflowSchema,
		contract: {
			capabilities: new Set(["delegate"]),
			permission: {
				defaultBehavior: "deny",
				matches: () => false,
				describe: () => "Workflow execution is disabled during migration",
				ruleForCall: () => null,
			},
			context: { resultRecoverable: false, deferSchema: true },
			evidence: {
				emits: new Set(["workflow"]),
				capture: (params): EvidenceRecord[] => [
					{
						kind: "workflow",
						agentType: "workflow",
						task: params.name ?? "disabled workflow",
						handle: params.runId,
					},
				],
			},
		},
		async execute(): Promise<AgentToolResult<WorkflowDetails>> {
			throw new Error(WORKFLOW_MIGRATION_MESSAGE);
		},
		renderCall(input, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCall(input, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = result.details.output;
			text.setText(
				options.expanded
					? theme.fg("toolOutput", output)
					: formatHiddenLines(output ? output.split("\n").length : 0, "all"),
			);
			return text;
		},
	};
}

export function createWorkflowTool(runtime: DelegationRuntimeOptions) {
	return wrapToolDefinition(createWorkflowToolDefinition(runtime));
}
