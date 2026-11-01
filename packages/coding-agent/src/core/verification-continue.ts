import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import type { ToolContractSnapshotEntry } from "./tools/contract-snapshot.ts";

/**
 * Spec 2026-10-23-coding-turn-quality.md, slice 3. A mutating turn with a
 * configured verification policy gets one repair continuation when the policy
 * fails. A read-only turn does not run the policy. The caller still owns the
 * command. This only decides whether to ask.
 */

export interface VerificationContinueInput {
	readonly policyIds: readonly string[];
	readonly mutated: boolean;
	readonly continuationsUsed: number;
	readonly status?: "verified" | "failed" | "interrupted" | "unavailable" | "continued-unverified";
}

export type VerificationContinueDecision =
	| { readonly type: "skip" }
	| { readonly type: "run"; readonly policyId: string }
	| { readonly type: "continue"; readonly prompt: string }
	| { readonly type: "stop" };

export function turnMutated(
	toolResults: readonly Pick<ToolResultMessage, "toolName">[],
	snapshot: readonly ToolContractSnapshotEntry[],
): boolean {
	return toolResults.some((result) =>
		snapshot.some((entry) => entry.name === result.toolName && entry.capabilities.includes("fs.write")),
	);
}

export function decideVerificationContinue(input: VerificationContinueInput): VerificationContinueDecision {
	if (input.policyIds.length === 0) return { type: "skip" };
	if (!input.mutated) return { type: "skip" };
	if (input.continuationsUsed >= 1) return { type: "stop" };
	if (input.status === undefined) return { type: "run", policyId: input.policyIds[0] };
	if (input.status === "verified" || input.status === "continued-unverified" || input.status === "unavailable") {
		return { type: "stop" };
	}
	return {
		type: "continue",
		prompt: `Verification failed. Policy ${input.policyIds[0]} returned ${input.status}. Fix the failure and leave the policy passing.`,
	};
}
