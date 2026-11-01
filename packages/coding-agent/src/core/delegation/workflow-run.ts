import type { DelegationRuntimeOptions } from "./runtime.ts";

export const WORKFLOW_MIGRATION_MESSAGE =
	"Workflow execution is disabled during migration from JavaScript scripts to declarative JSON workflows. No script or child was started. JSON parsing and host authorization will be added in H2.";

export interface WorkflowCallRecord {
	order: number;
	agentType: string;
	prompt: string;
	hash: string;
	value?: unknown;
	failed?: string;
}

/** Retained for callers that display workflow results. Execution is disabled. */
export interface WorkflowRunResult {
	value: unknown;
	calls: WorkflowCallRecord[];
	phases: { title: string; calls: number }[];
	warnings: string[];
}

export interface WorkflowRunRequest {
	args?: unknown;
	runId?: string;
}

/** Legacy compatibility boundary. Never evaluates source or reads replay state. */
export async function runWorkflow(
	_options: DelegationRuntimeOptions,
	_script: string,
	_request: WorkflowRunRequest = {},
): Promise<WorkflowRunResult> {
	throw new Error(WORKFLOW_MIGRATION_MESSAGE);
}
