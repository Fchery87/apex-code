import { describe, expect, it } from "vitest";
import { decideResponseRecovery, type ResponseRecoveryInput, recoveryForTurn } from "../src/core/response-recovery.ts";

/**
 * Spec 2026-10-23-coding-turn-quality.md, slice 1. The decision is pure.
 * The session applies it after a turn that produced no executable tool call.
 */

function input(overrides: Partial<ResponseRecoveryInput> = {}): ResponseRecoveryInput {
	return {
		stopReason: "stop",
		visibleText: "Done.",
		priorRole: "user",
		hasToolCallMarkup: false,
		truncatedContinuationsUsed: 0,
		emptyContinuationsUsed: 0,
		markupNudgesUsed: 0,
		...overrides,
	};
}

describe("response recovery decision", () => {
	it("does not continue a finished answer", () => {
		expect(decideResponseRecovery(input())).toEqual({ type: "stop" });
	});

	it("continues a length stop that produced no tool call, up to 3", () => {
		const decision = decideResponseRecovery(
			input({ stopReason: "length", visibleText: "partial", truncatedContinuationsUsed: 2 }),
		);
		expect(decision.type).toBe("continue");
		if (decision.type === "continue") {
			expect(decision.kind).toBe("truncated");
			expect(decision.prompt).toContain("length");
		}
	});

	it("stops a length stop after 3 continuations", () => {
		expect(
			decideResponseRecovery(input({ stopReason: "length", visibleText: "partial", truncatedContinuationsUsed: 3 })),
		).toEqual({ type: "stop" });
	});

	it("continues an empty reply whose prior message is a tool result, up to 5", () => {
		const decision = decideResponseRecovery(
			input({ stopReason: "stop", visibleText: "  ", priorRole: "toolResult", emptyContinuationsUsed: 4 }),
		);
		expect(decision.type).toBe("continue");
		if (decision.type === "continue") expect(decision.kind).toBe("empty");
	});

	it("stops an empty reply after 5 continuations", () => {
		expect(
			decideResponseRecovery(
				input({ stopReason: "stop", visibleText: "", priorRole: "toolResult", emptyContinuationsUsed: 5 }),
			),
		).toEqual({ type: "stop" });
	});

	it("does not treat an empty reply after a user message as a provider hiccup", () => {
		expect(decideResponseRecovery(input({ visibleText: "", priorRole: "user" }))).toEqual({ type: "stop" });
	});

	it("nudges once when the text contains an unparsed tool call and no real tool call", () => {
		const decision = decideResponseRecovery(
			input({ visibleText: "I will call <tool_call>read</tool_call> now", hasToolCallMarkup: true }),
		);
		expect(decision.type).toBe("continue");
		if (decision.type === "continue") expect(decision.kind).toBe("markup");
	});

	it("does not nudge tool-call markup a second time", () => {
		expect(
			decideResponseRecovery(
				input({ visibleText: "<tool_call>read</tool_call>", hasToolCallMarkup: true, markupNudgesUsed: 1 }),
			),
		).toEqual({ type: "stop" });
	});

	it("does not continue a length stop, because compact-and-retry owns that", () => {
		expect(
			recoveryForTurn(
				{
					stopReason: "length",
					visibleText: "partial",
					priorRole: "user",
					hasToolCalls: false,
					hasToolResults: false,
				},
				{ empty: 0, markup: 0 },
			),
		).toEqual({ type: "stop" });
	});

	it("does not recover a turn that already ran tools", () => {
		expect(
			recoveryForTurn(
				{ stopReason: "stop", visibleText: "", priorRole: "toolResult", hasToolCalls: false, hasToolResults: true },
				{ empty: 0, markup: 0 },
			),
		).toEqual({ type: "stop" });
	});
});
