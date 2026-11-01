import { createHash } from "node:crypto";
import type { ChildWorkspaceRequest, DelegationRuntimeOptions } from "./runtime.ts";
import { retrieveDelegationResult, runDelegation } from "./runtime.ts";
import {
	parseWorkflowDefinition,
	renderWorkflowPrompt,
	selectWorkflowReference,
	type WorkflowDefinition,
	type WorkflowStep,
} from "./workflow-definition.ts";
import { assertWorkflowIdentifier, resolveWorkflowDefinition } from "./workflow-files.ts";
import { parseWorkflowOutput, validateWorkflowOutputSchema } from "./workflow-output.ts";
import { DEFAULT_WORKFLOW_CONCURRENCY, WORKFLOW_DEADLINE_MS, WorkflowScheduler } from "./workflow-scheduler.ts";

export const WORKFLOW_SCRIPT_MAX_BYTES = 64 * 1024;
export const WORKFLOW_MIGRATION_MESSAGE =
	"Workflow JavaScript execution is disabled. Migrate to a versioned JSON definition. No child was started.";

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

function callHash(prompt: string, step: WorkflowStep, args: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify([step.id, prompt, step.agentType ?? "explore", args ?? null]))
		.digest("hex");
}

function normalizeWorkflowOutput(output: string): unknown {
	try {
		return JSON.parse(output);
	} catch {
		return output;
	}
}

export function parseWorkflowRequest(input: unknown): WorkflowRequest {
	if (typeof input === "string" || (input && typeof input === "object" && "script" in input)) {
		throw new Error(WORKFLOW_MIGRATION_MESSAGE);
	}
	if (!input || typeof input !== "object" || !("kind" in input)) {
		throw new Error("workflow requires a saved or inline request.");
	}
	const allowed = input.kind === "saved" ? ["kind", "name", "args", "runId"] : ["kind", "definition", "args", "runId"];
	if (Object.keys(input).some((key) => !allowed.includes(key))) {
		throw new Error("workflow saved and inline requests cannot carry replacement bodies or extra fields.");
	}
	if ("runId" in input && input.runId !== undefined) assertWorkflowIdentifier(input.runId, "run");
	const args = "args" in input ? input.args : undefined;
	const runId = "runId" in input && typeof input.runId === "string" ? input.runId : undefined;
	if (input.kind === "saved" && "name" in input) {
		assertWorkflowIdentifier(input.name, "workflow");
		return { kind: "saved", name: input.name, args, runId };
	}
	if (input.kind === "inline" && "definition" in input) {
		if (typeof input.definition === "string") throw new Error(WORKFLOW_MIGRATION_MESSAGE);
		if (!input.definition || typeof input.definition !== "object" || Array.isArray(input.definition)) {
			throw new Error("workflow inline definition must be a JSON object.");
		}
		return { kind: "inline", definition: input.definition, args, runId };
	}
	throw new Error("workflow requires a saved name or inline definition.");
}

function resolveDefinition(input: unknown, cwd: string): WorkflowDefinition {
	const request = parseWorkflowRequest(input);
	if (request.kind === "saved") {
		const saved = resolveWorkflowDefinition(cwd, request.name);
		return saved.definition;
	}
	return parseWorkflowDefinition(request.definition);
}

async function executeStep(
	options: DelegationRuntimeOptions,
	step: WorkflowStep,
	args: unknown,
	outputs: ReadonlyMap<string, unknown>,
	callOrder: number,
	signal: AbortSignal | undefined,
): Promise<{ stepId: string; output: unknown; call: WorkflowCallRecord }> {
	if (signal?.aborted) throw new Error(`Workflow cancelled before step "${step.id}" started.`);
	const prompt = renderWorkflowPrompt(step, args, outputs);
	const agentType = step.agentType ?? "explore";
	const workspace: ChildWorkspaceRequest = {
		isolation: step.isolation === "worktree" ? "worktree" : "shared-read",
		ownedPaths: [],
	};
	const started = await runDelegation(options, agentType, prompt, { background: true, signal, workspace });
	if (!started.handleId) throw new Error(`Workflow step "${step.id}" started without a child handle.`);
	let result: Awaited<ReturnType<typeof retrieveDelegationResult>>;
	let removeAbortListener: (() => void) | undefined;
	try {
		const retrieval = retrieveDelegationResult(options, started.handleId, agentType);
		if (signal) {
			const cancelled = new Promise<never>((_, reject) => {
				const onAbort = () => {
					signal.removeEventListener("abort", onAbort);
					const reason = signal.reason;
					reject(reason instanceof Error ? reason : new Error("Workflow step was cancelled."));
				};
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			});
			result = await Promise.race([retrieval, cancelled]);
		} else {
			result = await retrieval;
		}
		if (signal?.aborted) throw signal.reason;
		if (result.outcome === "interrupted") throw new Error(`Workflow step "${step.id}" was interrupted.`);
	} finally {
		removeAbortListener?.();
		options.childRunRegistry?.close(started.handleId);
	}
	const output =
		step.schema === undefined
			? normalizeWorkflowOutput(result.output)
			: parseWorkflowOutput(result.output, step.schema);
	return {
		stepId: step.id,
		output,
		call: {
			stepId: step.id,
			order: callOrder,
			agentType,
			prompt,
			hash: callHash(prompt, step, args),
			value: result.output,
			outcome: "succeeded",
		},
	};
}

async function executeDefinition(
	options: DelegationRuntimeOptions,
	definition: WorkflowDefinition,
	args: unknown,
	signal: AbortSignal | undefined,
): Promise<WorkflowRunResult> {
	const outputs = new Map<string, unknown>();
	const calls: WorkflowCallRecord[] = [];
	const phases = new Map<string, { title: string; calls: number }>();
	const remaining = new Map(definition.steps.map((step) => [step.id, step]));
	const failedSteps = new Set<string>();
	const stoppedFailures = new Set<string>();
	let workflowFailed = false;
	let workflowCancelled = false;
	const width = Math.min(
		definition.concurrency ?? DEFAULT_WORKFLOW_CONCURRENCY,
		options.maxConcurrentChildren ?? Number.POSITIVE_INFINITY,
	);
	for (const step of definition.steps) if (step.schema !== undefined) validateWorkflowOutputSchema(step.schema);
	const batchController = new AbortController();
	const relayAbort = () => batchController.abort(signal?.reason ?? new Error("Workflow cancelled."));
	if (signal?.aborted) relayAbort();
	else signal?.addEventListener("abort", relayAbort, { once: true });
	const scheduler = new WorkflowScheduler({ concurrency: width, signal: batchController.signal });
	try {
		while (remaining.size > 0) {
			if (batchController.signal.aborted) break;
			for (const step of [...remaining.values()]) {
				if ((step.needs ?? []).some((need) => failedSteps.has(need))) {
					calls.push({
						stepId: step.id,
						order: calls.length + 1,
						agentType: step.agentType ?? "explore",
						prompt: "",
						hash: "",
						outcome: "blocked",
					});
					remaining.delete(step.id);
				}
			}
			const ready = [...remaining.values()].filter((step) => (step.needs ?? []).every((need) => outputs.has(need)));
			if (ready.length === 0) {
				if ((definition.failurePolicy ?? "stop") === "continue-independent") {
					for (const step of remaining.values()) {
						calls.push({
							stepId: step.id,
							order: calls.length + 1,
							agentType: step.agentType ?? "explore",
							prompt: "",
							hash: "",
							outcome: "blocked",
						});
					}
					remaining.clear();
					continue;
				}
				throw new Error("Workflow has no runnable steps. Check its dependencies.");
			}
			const results = await Promise.allSettled(
				ready.map((step, index) =>
					scheduler
						.schedule(() =>
							executeStep(options, step, args, outputs, calls.length + index + 1, batchController.signal),
						)
						.catch((error) => {
							if ((definition.failurePolicy ?? "stop") === "stop" && !batchController.signal.aborted) {
								stoppedFailures.add(step.id);
								batchController.abort(error);
							}
							throw error;
						}),
				),
			);
			for (const [index, result] of results.entries()) {
				if (result.status === "rejected") {
					const step = ready[index];
					if (step) {
						const cancelled =
							!!signal?.aborted ||
							((definition.failurePolicy ?? "stop") === "stop" && !stoppedFailures.has(step.id));
						workflowFailed ||= !cancelled;
						workflowCancelled ||= !!signal?.aborted;
						failedSteps.add(step.id);
						calls.push({
							stepId: step.id,
							order: calls.length + 1,
							agentType: step.agentType ?? "explore",
							prompt: "",
							hash: "",
							failed: String(result.reason),
							outcome: cancelled ? "cancelled" : "failed",
						});
						remaining.delete(step.id);
					}
					continue;
				}
				const { stepId, output, call } = result.value;
				outputs.set(stepId, output);
				calls.push(call);
				remaining.delete(stepId);
				const step = remaining.get(stepId) ?? definition.steps.find((candidate) => candidate.id === stepId);
				if (step?.phase) {
					const phase = phases.get(step.phase) ?? { title: step.phase, calls: 0 };
					phase.calls += 1;
					phases.set(step.phase, phase);
				}
			}
		}
		if (batchController.signal.aborted) {
			workflowCancelled ||= !!signal?.aborted;
			for (const step of remaining.values()) {
				calls.push({
					stepId: step.id,
					order: calls.length + 1,
					agentType: step.agentType ?? "explore",
					prompt: "",
					hash: "",
					outcome: "blocked",
				});
			}
		}
	} finally {
		if (signal) signal.removeEventListener("abort", relayAbort);
	}
	return {
		value: batchController.signal.aborted ? undefined : selectWorkflowReference(definition.output, args, outputs),
		outcome: workflowCancelled ? "cancelled" : workflowFailed ? "failed" : "succeeded",
		calls,
		phases: [...phases.values()],
		warnings: [],
	};
}

export async function runWorkflow(
	_options: DelegationRuntimeOptions,
	input: unknown,
	request: WorkflowRunRequest = {},
): Promise<WorkflowRunResult> {
	if (request.signal?.aborted) throw new Error("Workflow cancelled before dispatch. No child was started.");
	if (request.runId !== undefined) assertWorkflowIdentifier(request.runId, "run");
	const definition = resolveDefinition(input, request.cwd ?? process.cwd());
	const args = input && typeof input === "object" && "args" in input ? input.args : request.args;
	const controller = new AbortController();
	const onAbort = () => controller.abort(new Error("Workflow cancelled by its parent."));
	request.signal?.addEventListener("abort", onAbort, { once: true });
	if (request.signal?.aborted) onAbort();
	const timer = setTimeout(
		() => controller.abort(new Error("Workflow deadline exceeded.")),
		definition.timeoutMs ?? WORKFLOW_DEADLINE_MS,
	);
	try {
		return await executeDefinition(_options, definition, args, controller.signal);
	} finally {
		clearTimeout(timer);
		request.signal?.removeEventListener("abort", onAbort);
	}
}
