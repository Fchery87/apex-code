import { describe, expect, it } from "vitest";
import { decideVerificationContinue, turnMutated } from "../src/core/verification-continue.ts";

describe("verification continue", () => {
	it("skips a turn that did not mutate", () => {
		expect(turnMutated([{ toolName: "read" }])).toBe(false);
		expect(decideVerificationContinue({ policyIds: ["typecheck"], mutated: false, continuationsUsed: 0 })).toEqual({
			type: "skip",
		});
	});

	it("skips when no policy is configured", () => {
		expect(decideVerificationContinue({ policyIds: [], mutated: true, continuationsUsed: 0 })).toEqual({
			type: "skip",
		});
	});

	it("asks to run the first policy before a status exists", () => {
		expect(decideVerificationContinue({ policyIds: ["typecheck"], mutated: true, continuationsUsed: 0 })).toEqual({
			type: "run",
			policyId: "typecheck",
		});
	});

	it("continues once when the policy failed", () => {
		const decision = decideVerificationContinue({
			policyIds: ["typecheck"],
			mutated: true,
			continuationsUsed: 0,
			status: "failed",
		});
		expect(decision.type).toBe("continue");
	});

	it("stops after one repair and when the policy passed", () => {
		expect(
			decideVerificationContinue({
				policyIds: ["typecheck"],
				mutated: true,
				continuationsUsed: 1,
				status: "failed",
			}),
		).toEqual({ type: "stop" });
		expect(
			decideVerificationContinue({
				policyIds: ["typecheck"],
				mutated: true,
				continuationsUsed: 0,
				status: "verified",
			}),
		).toEqual({ type: "stop" });
	});
});
