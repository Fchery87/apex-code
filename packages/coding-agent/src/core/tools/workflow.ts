import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "apex-code-agent-core";
import { minimatch } from "minimatch";
import { type Static, Type } from "typebox";
import { formatHiddenLines } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { DelegationRuntimeOptions } from "../delegation/runtime.ts";
import { runWorkflow } from "../delegation/workflow-run.ts";
import type { ApexToolDefinition, EvidenceRecord } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * Runs a script that starts children through the delegation runtime
 * (spec 2026-10-26). The script is the orchestrator. The parent sees the
 * script's return value, not each child's transcript.
 *
 * A script body the model just wrote is shown to the user before any child
 * starts. A saved script names itself, and a permission rule can allow that
 * name. Headless sessions have no UI, so an unsaved body is refused there
 * rather than run unseen.
 */

const workflowSchema = Type.Object({
	script: Type.String({ description: "JavaScript with top-level await. Call worker(), parallel(), and pipeline()." }),
	args: Type.Optional(Type.Unknown({ description: "JSON value the script reads as args." })),
	runId: Type.Optional(
		Type.String({ description: "Stable id. A second call with the same id reuses finished workers." }),
	),
	name: Type.Optional(
		Type.String({ description: "Set when running a saved script. A permission rule matches this name." }),
	),
});

export type WorkflowInput = Static<typeof workflowSchema>;

export interface WorkflowDetails {
	output: string;
	runId: string;
	calls: number;
	/** phase() titles in order, with the worker calls that followed each. */
	phases: { title: string; calls: number }[];
	warnings: string[];
}

const approvedBodies = new Set<string>();

function formatCall(input: WorkflowInput, theme: Theme): string {
	const name = input.name ?? "script";
	return `${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", name)}`;
}

export function createWorkflowToolDefinition(
	runtime: DelegationRuntimeOptions,
): ApexToolDefinition<typeof workflowSchema, WorkflowDetails> {
	return {
		name: "workflow",
		label: "workflow",
		description:
			"Run a script that starts subagents. The script calls worker(prompt), parallel([prompts]), and pipeline(items, fn). It cannot read files or run commands itself. Returns the script's value.",
		parameters: workflowSchema,
		contract: {
			capabilities: new Set(["delegate"]),
			permission: {
				defaultBehavior: "ask",
				matches: (ruleContent, params) => (params.name ? minimatch(params.name, ruleContent) : false),
				describe: (ruleContent) => `Run saved workflow scripts matching "${ruleContent}"`,
				ruleForCall: (params) => params.name ?? null,
			},
			context: { resultRecoverable: false, deferSchema: true },
			evidence: {
				emits: new Set(["workflow"]),
				capture: (params): EvidenceRecord[] => [
					{
						kind: "workflow",
						agentType: "workflow",
						task: params.name ?? params.script.slice(0, 200),
						handle: params.runId,
					},
				],
			},
		},
		async execute(
			_toolCallId,
			input: WorkflowInput,
			_signal,
			_onUpdate,
			ctx,
		): Promise<AgentToolResult<WorkflowDetails>> {
			const runId = input.runId ?? `workflow-${approvedBodies.size + 1}`;
			if (!input.name && !approvedBodies.has(input.script)) {
				if (!ctx?.hasUI) {
					throw new Error(
						"workflow: a script the model just wrote needs approval, and this session has no UI. Save it and allow it by name.",
					);
				}
				const answer = await ctx.ui.select(`Run this workflow script?\n\n${input.script}`, ["Run", "Don't run"]);
				if (answer !== "Run") throw new Error("workflow: the user declined the script. No child was started.");
				approvedBodies.add(input.script);
			}
			const result = await runWorkflow(runtime, input.script, { args: input.args, runId });
			const text = JSON.stringify(result.value);
			return {
				content: [{ type: "text", text }],
				details: {
					output: text,
					runId,
					calls: result.calls.length,
					phases: result.phases,
					warnings: result.warnings,
				},
			};
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
