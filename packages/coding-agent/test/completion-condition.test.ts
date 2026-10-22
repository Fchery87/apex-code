import { describe, expect, it } from "vitest";
import { type CompletionCheckInput, decideCompletionCheck } from "../src/core/completion-condition.ts";

/**
 * Spec 2026-10-22-completion-check.md. The decision is pure. The session
 * applies it after a turn. This file pins the four outcomes before the
 * session wiring exists.
 */

function input(overrides: Partial<CompletionCheckInput> = {}): CompletionCheckInput {
	return {
		policyId: "typecheck",
		status: "failed",
		continuationsUsed: 0,
		maxTurns: 5,
		...overrides,
	};
}

describe("completion check decision", () => {
	it("clears the condition when the policy is verified", () => {
		expect(decideCompletionCheck(input({ status: "verified" }))).toEqual({ type: "clear" });
	});

	it("continues with the policy id, status, and exit code when the policy fails", () => {
		expect(decideCompletionCheck(input({ status: "failed", exitCode: 1, continuationsUsed: 2 }))).toEqual({
			type: "continue",
			prompt:
				"Completion check failed. Policy typecheck returned failed with exit code 1. Fix the failure and leave the policy passing.",
		});
	});

	it("names the signal when the policy was interrupted", () => {
		expect(decideCompletionCheck(input({ status: "interrupted", signal: "SIGTERM" }))).toEqual({
			type: "continue",
			prompt:
				"Completion check failed. Policy typecheck returned interrupted with signal SIGTERM. Fix the failure and leave the policy passing.",
		});
	});

	it("does not continue when the policy is missing", () => {
		expect(decideCompletionCheck(input({ status: "unavailable" }))).toEqual({
			type: "clear",
			reason: "policy-missing",
		});
	});

	it("stops at the cap without another continuation", () => {
		expect(decideCompletionCheck(input({ continuationsUsed: 5, maxTurns: 5, exitCode: 1 }))).toEqual({
			type: "stop-at-cap",
		});
	});
});
