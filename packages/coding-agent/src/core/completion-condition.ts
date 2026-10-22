import type { VerificationCompletionStatus, VerificationEvidence } from "./verification-lifecycle.ts";

/**
 * Spec 2026-10-22-completion-check.md. One pure decision. The session applies
 * it after a turn and does not run a command here.
 */

export interface CompletionCondition {
	readonly policyId: string;
	readonly maxTurns: number;
}

export interface CompletionCheckInput {
	readonly policyId: string;
	readonly status: VerificationCompletionStatus;
	readonly continuationsUsed: number;
	readonly maxTurns: number;
	readonly exitCode?: number;
	readonly signal?: string;
}

export type CompletionCheckDecision =
	| { readonly type: "clear"; readonly reason?: "policy-missing" }
	| { readonly type: "continue"; readonly prompt: string }
	| { readonly type: "stop-at-cap" };

export const DEFAULT_COMPLETION_MAX_TURNS = 5;

export function decideCompletionCheck(input: CompletionCheckInput): CompletionCheckDecision {
	if (input.status === "unavailable") return { type: "clear", reason: "policy-missing" };
	if (input.status === "verified" || input.status === "continued-unverified") return { type: "clear" };
	if (input.continuationsUsed >= input.maxTurns) return { type: "stop-at-cap" };
	return { type: "continue", prompt: continuationPrompt(input) };
}

/** The detail a continuation prompt may carry. Output stays in the artifact. */
export function evidenceDetail(
	evidence: VerificationEvidence | undefined,
): Pick<CompletionCheckInput, "exitCode" | "signal"> {
	if (evidence === undefined) return {};
	return {
		...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
		...(evidence.signal !== undefined ? { signal: evidence.signal } : {}),
	};
}

function continuationPrompt(input: CompletionCheckInput): string {
	const detail =
		input.exitCode !== undefined
			? ` with exit code ${input.exitCode}`
			: input.signal !== undefined
				? ` with signal ${input.signal}`
				: "";
	return `Completion check failed. Policy ${input.policyId} returned ${input.status}${detail}. Fix the failure and leave the policy passing.`;
}
