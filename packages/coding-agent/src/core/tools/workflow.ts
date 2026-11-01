import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import { formatHiddenLines } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { DelegationRuntimeOptions } from "../delegation/runtime.ts";
import { parseWorkflowDefinition, workflowDefinitionDigest } from "../delegation/workflow-definition.ts";
import { resolveWorkflowDefinition } from "../delegation/workflow-files.ts";
import { parseWorkflowRequest, runWorkflow, type WorkflowRunResult } from "../delegation/workflow-run.ts";
import type { ApexToolDefinition, EvidenceRecord } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * Runs a validated workflow request through the delegation runtime. JavaScript
 * workflow bodies are rejected by the request parser and never reach a child.
 */

const workflowSchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("saved"), Type.Literal("inline")]),
		name: Type.Optional(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" })),
		definition: Type.Optional(
			Type.Unknown({ description: "Versioned JSON workflow definition. It never contains executable code." }),
		),
		args: Type.Optional(Type.Unknown()),
		runId: Type.Optional(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" })),
	},
	{ additionalProperties: false },
);

export type WorkflowInput = Static<typeof workflowSchema>;

export interface WorkflowDetails {
	output: string;
	outcome: WorkflowRunResult["outcome"];
	steps: WorkflowRunResult["calls"];
	runId: string;
	calls: number;
	/** phase() titles in order, with the worker calls that followed each. */
	phases: { title: string; calls: number }[];
	warnings: string[];
}

function formatCall(input: WorkflowInput, theme: Theme): string {
	const name = input.kind === "saved" ? (input.name ?? "saved") : "inline";
	return `${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", name)}`;
}

export function createWorkflowToolDefinition(
	runtime: DelegationRuntimeOptions,
): ApexToolDefinition<typeof workflowSchema, WorkflowDetails> {
	const preparedCalls = new WeakMap<object, string>();
	const approvedCalls = new WeakMap<object, string>();
	const authorizationKey = (params: WorkflowInput): string | undefined => {
		const authorization = runtime.workflowAuthorization;
		if (!authorization) return undefined;
		const identity =
			params.kind === "saved"
				? { name: params.name, digest: authorization.resolveSaved(params.name ?? "").digest }
				: { name: "inline", digest: workflowDefinitionDigest(parseWorkflowDefinition(params.definition)) };
		return JSON.stringify({
			...identity,
			sessionId: authorization.sessionId(),
			trustContext: `${authorization.trustContext()}:${authorization.projectTrusted()}`,
		});
	};
	return {
		name: "workflow",
		label: "workflow",
		description: "Run a saved or inline versioned JSON workflow. JavaScript workflow bodies are not supported.",
		parameters: workflowSchema,
		contract: {
			capabilities: new Set(["delegate"]),
			permission: {
				defaultBehavior: "ask",
				defaultBehaviorFor: (params) => ("script" in params ? "deny" : undefined),
				prepareCall: (params) => {
					parseWorkflowRequest(params);
					const key = authorizationKey(params);
					if (key) preparedCalls.set(params, key);
				},
				protectedTarget: () => {
					if (runtime.workflowAuthorization && !runtime.workflowAuthorization.projectTrusted())
						return "the project is not trusted for workflow execution";
					return undefined;
				},
				matches: (ruleContent, params) =>
					runtime.workflowAuthorization
						? authorizationKey(params) === ruleContent
						: params.kind === "saved" && params.name === ruleContent,
				describe: (ruleContent) =>
					runtime.workflowAuthorization
						? "Run this exact saved or inline workflow definition"
						: `Run saved workflow scripts matching "${ruleContent}"`,
				ruleForCall: (params) =>
					runtime.workflowAuthorization
						? (authorizationKey(params) ?? null)
						: params.kind === "saved" && params.name
							? params.name
							: null,
				onApproved: (params) => {
					const key = authorizationKey(params);
					if (key) {
						if (key !== preparedCalls.get(params)) throw new Error("Workflow identity changed during approval.");
						approvedCalls.set(params, key);
					}
				},
			},
			context: { resultRecoverable: false, deferSchema: true },
			evidence: {
				emits: new Set(["workflow"]),
				capture: (params): EvidenceRecord[] => [
					{
						kind: "workflow",
						agentType: "workflow",
						task: params.kind === "saved" ? (params.name ?? "saved workflow") : "inline workflow",
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
			let executionInput: unknown = input;
			if (runtime.workflowAuthorization) {
				if (!runtime.workflowAuthorization.projectTrusted())
					throw new Error("Workflow project is no longer trusted.");
				const key = authorizationKey(input);
				if (!key || approvedCalls.get(input) !== key)
					throw new Error("Workflow approval identity changed before execution.");
				approvedCalls.delete(input);
				const request = parseWorkflowRequest(input);
				const definition =
					request.kind === "saved"
						? resolveWorkflowDefinition(ctx?.cwd ?? process.cwd(), request.name).definition
						: parseWorkflowDefinition(request.definition);
				const expectedDigest = JSON.parse(key).digest;
				if (workflowDefinitionDigest(definition) !== expectedDigest)
					throw new Error("Workflow definition changed after approval.");
				executionInput = { kind: "inline", definition, args: request.args, runId: request.runId };
			}
			const runId = input.runId ?? (input.kind === "saved" ? (input.name ?? "workflow-saved") : "workflow-inline");
			const result = await runWorkflow(runtime, executionInput, {
				args: input.args,
				runId,
				signal: _signal,
				cwd: ctx?.cwd ?? process.cwd(),
			});
			const text =
				result.outcome === "succeeded"
					? (JSON.stringify(result.value) ?? "null")
					: JSON.stringify({ outcome: result.outcome, value: result.value, steps: result.calls });
			return {
				content: [{ type: "text", text }],
				details: {
					output: text,
					outcome: result.outcome,
					steps: result.calls,
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
