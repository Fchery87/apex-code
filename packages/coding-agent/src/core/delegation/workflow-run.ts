import { createHash } from "node:crypto";
import type { DelegationRuntimeOptions } from "./runtime.ts";
import { retrieveDelegationResult, runDelegation } from "./runtime.ts";
import {
	parseWorkflowDefinition,
	renderWorkflowPrompt,
	selectWorkflowReference,
	type WorkflowStep,
} from "./workflow-definition.ts";
import { assertWorkflowIdentifier, resolveWorkflowDefinition } from "./workflow-files.ts";
import { parseWorkflowOutput, validateWorkflowOutputSchema } from "./workflow-output.ts";

export const WORKFLOW_SCRIPT_MAX_BYTES = 64 * 1024;
export const WORKFLOW_MIGRATION_MESSAGE =
	"Workflow JavaScript execution is disabled during migration. Supply a versioned JSON definition. No child was started.";

export type WorkflowRequest =
	| { kind: "saved"; name: string; args?: unknown; runId?: string }
	| { kind: "inline"; definition: unknown; args?: unknown; runId?: string };

export interface WorkflowCallRecord {
	stepId: string;
	order: number;
	agentType: string;
	prompt: string;
	hash: string;
	value?: unknown;
	failed?: string;
	outcome: "succeeded" | "failed" | "cancelled" | "blocked";
}
export interface WorkflowRunResult {
	value: unknown;
	outcome: "succeeded" | "failed" | "cancelled";
	calls: WorkflowCallRecord[];
	phases: { title: string; calls: number }[];
	warnings: string[];
}
export interface WorkflowRunRequest {
	args?: unknown;
	runId?: string;
	signal?: AbortSignal;
	cwd?: string;
}

export function parseWorkflowRequest(input: unknown): WorkflowRequest {
	if (typeof input === "string" || (input && typeof input === "object" && "script" in input))
		throw new Error(WORKFLOW_MIGRATION_MESSAGE);
	if (!input || typeof input !== "object" || !("kind" in input))
		throw new Error("workflow requires a saved or inline request.");
	const allowed = input.kind === "saved" ? ["kind", "name", "args", "runId"] : ["kind", "definition", "args", "runId"];
	if (Object.keys(input).some((key) => !allowed.includes(key)))
		throw new Error("workflow saved and inline requests cannot carry replacement bodies or extra fields.");
	if ("runId" in input && input.runId !== undefined) assertWorkflowIdentifier(input.runId, "run");
	const args = "args" in input ? input.args : undefined;
	const runId = "runId" in input && typeof input.runId === "string" ? input.runId : undefined;
	if (input.kind === "saved" && "name" in input) {
		assertWorkflowIdentifier(input.name, "workflow");
		return { kind: "saved", name: input.name, args, runId };
	}
	if (input.kind === "inline" && "definition" in input) {
		if (typeof input.definition === "string") throw new Error(WORKFLOW_MIGRATION_MESSAGE);
		if (!input.definition || typeof input.definition !== "object" || Array.isArray(input.definition))
			throw new Error("workflow inline definition must be a JSON object.");
		return { kind: "inline", definition: input.definition, args, runId };
	}
	throw new Error("workflow requires a saved name or inline definition.");
}

function normalizeOutput(output: string): unknown {
	try {
		return JSON.parse(output);
	} catch {
		return output;
	}
}

async function executeStep(
	options: DelegationRuntimeOptions,
	step: WorkflowStep,
	args: unknown,
	outputs: ReadonlyMap<string, unknown>,
	order: number,
	signal?: AbortSignal,
): Promise<{ output: unknown; call: WorkflowCallRecord }> {
	signal?.throwIfAborted();
	const prompt = renderWorkflowPrompt(step, args, outputs);
	const agentType = step.agentType ?? "explore";
	const started = await runDelegation(options, agentType, prompt, {
		background: true,
		signal,
		workspace: { isolation: step.isolation ?? "shared-read", ownedPaths: [] },
	});
	if (!started.handleId) throw new Error(`Workflow step "${step.id}" started without a child handle.`);
	try {
		const result = await retrieveDelegationResult(options, started.handleId, agentType);
		signal?.throwIfAborted();
		if (result.outcome === "interrupted") throw new Error(`Workflow step "${step.id}" was interrupted.`);
		const output =
			step.schema === undefined ? normalizeOutput(result.output) : parseWorkflowOutput(result.output, step.schema);
		return {
			output,
			call: {
				stepId: step.id,
				order,
				agentType,
				prompt,
				hash: createHash("sha256")
					.update(JSON.stringify([step.id, prompt, agentType, args ?? null]))
					.digest("hex"),
				value: result.output,
				outcome: "succeeded",
			},
		};
	} finally {
		options.childRunRegistry?.close(started.handleId);
	}
}

/** H2 interprets the validated graph sequentially. Scheduling belongs to H3. */
export async function runWorkflow(
	options: DelegationRuntimeOptions,
	input: unknown,
	request: WorkflowRunRequest = {},
): Promise<WorkflowRunResult> {
	const parsed = parseWorkflowRequest(input);
	if (request.signal?.aborted) throw new Error("Workflow cancelled before dispatch. No child was started.");
	if (request.runId !== undefined) assertWorkflowIdentifier(request.runId, "run");
	const definition =
		parsed.kind === "saved"
			? resolveWorkflowDefinition(request.cwd ?? process.cwd(), parsed.name).definition
			: parseWorkflowDefinition(parsed.definition);
	for (const step of definition.steps) if (step.schema !== undefined) validateWorkflowOutputSchema(step.schema);
	const args = parsed.args === undefined ? request.args : parsed.args;
	const outputs = new Map<string, unknown>();
	const calls: WorkflowCallRecord[] = [];
	const phases = new Map<string, { title: string; calls: number }>();
	const remaining = new Map(definition.steps.map((step) => [step.id, step]));
	while (remaining.size > 0) {
		const step = [...remaining.values()].find((candidate) =>
			(candidate.needs ?? []).every((need) => outputs.has(need)),
		);
		if (!step) throw new Error("Workflow has no runnable steps. Check its dependencies.");
		const result = await executeStep(options, step, args, outputs, calls.length + 1, request.signal);
		outputs.set(step.id, result.output);
		calls.push(result.call);
		remaining.delete(step.id);
		if (step.phase) {
			const phase = phases.get(step.phase) ?? { title: step.phase, calls: 0 };
			phase.calls += 1;
			phases.set(step.phase, phase);
		}
	}
	return {
		value: selectWorkflowReference(definition.output, args, outputs),
		outcome: "succeeded",
		calls,
		phases: [...phases.values()],
		warnings: [],
	};
}
