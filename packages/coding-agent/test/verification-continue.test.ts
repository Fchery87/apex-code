import { describe, expect, it } from "vitest";
import { UNCLASSIFIED } from "../src/core/tools/contract.ts";
import { buildToolContractSnapshot } from "../src/core/tools/contract-snapshot.ts";
import { decideVerificationContinue, turnMutated } from "../src/core/verification-continue.ts";

describe("verification continue", () => {
	it.each(["extension_write", "mcp__workspace__update"])("recognizes declared writes from %s", (name) => {
		const snapshot = buildToolContractSnapshot([
			{ name, contract: { ...UNCLASSIFIED, capabilities: new Set(["fs.write"]) } },
		]);
		expect(turnMutated([{ toolName: name }], snapshot)).toBe(true);
	});
	it("does not infer mutation from read-only command names or exec capability", () => {
		const snapshot = buildToolContractSnapshot([
			{ name: "bash", contract: { ...UNCLASSIFIED, capabilities: new Set(["exec"]) } },
		]);
		expect(turnMutated([{ toolName: "bash" }], snapshot)).toBe(false);
	});
	it("skips a turn that did not mutate", () => {
		expect(turnMutated([{ toolName: "read" }], [])).toBe(false);
		expect(
			turnMutated(
				[{ toolName: "extension_write" }],
				buildToolContractSnapshot([
					{
						name: "extension_write",
						contract: { ...UNCLASSIFIED, capabilities: new Set(["fs.write"]) },
					},
				]),
			),
		).toBe(true);
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
