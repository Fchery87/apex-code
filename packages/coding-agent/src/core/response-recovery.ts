/**
 * Spec 2026-10-23-coding-turn-quality.md, slice 1. One pure decision.
 * The session applies it after a turn that produced no executable tool call.
 * A finished answer is a stop. Caps are part of the decision, not the caller.
 */

export type ResponseRecoveryKind = "truncated" | "empty" | "markup";

export interface ResponseRecoveryInput {
	readonly stopReason: string;
	readonly visibleText: string;
	/** Role of the message before this assistant turn. */
	readonly priorRole: string | undefined;
	readonly hasToolCallMarkup: boolean;
	readonly truncatedContinuationsUsed: number;
	readonly emptyContinuationsUsed: number;
	readonly markupNudgesUsed: number;
}

export type ResponseRecoveryDecision =
	| { readonly type: "stop" }
	| { readonly type: "continue"; readonly kind: ResponseRecoveryKind; readonly prompt: string };

export const MAX_TRUNCATED_CONTINUATIONS = 3;
export const MAX_EMPTY_CONTINUATIONS = 5;

const TRUNCATED_STOPS = new Set(["length", "max_tokens", "max_output_tokens"]);

export function decideResponseRecovery(input: ResponseRecoveryInput): ResponseRecoveryDecision {
	const reason = input.stopReason.trim().toLowerCase();
	if (TRUNCATED_STOPS.has(reason) || reason.includes("truncat")) {
		if (input.truncatedContinuationsUsed >= MAX_TRUNCATED_CONTINUATIONS) return { type: "stop" };
		return {
			type: "continue",
			kind: "truncated",
			prompt: `The previous response ended before completion (stop reason: ${reason}). Continue exactly where you left off. Do not repeat completed content. If the next step is a tool call, emit the tool call now.`,
		};
	}
	if (input.visibleText.trim().length === 0 && input.priorRole === "toolResult") {
		if (input.emptyContinuationsUsed >= MAX_EMPTY_CONTINUATIONS) return { type: "stop" };
		return {
			type: "continue",
			kind: "empty",
			prompt:
				"The previous response was empty after tool results. Answer the user's last request using those results. Do not call more tools unless the results are insufficient.",
		};
	}
	if (input.hasToolCallMarkup && input.visibleText.trim().length > 0) {
		if (input.markupNudgesUsed >= 1) return { type: "stop" };
		return {
			type: "continue",
			kind: "markup",
			prompt:
				"The previous response described a tool call as text instead of calling the tool. Re-issue it as a real tool call. Do not write the call as text.",
		};
	}
	return { type: "stop" };
}

export interface RecoveryTurn {
	readonly stopReason: string;
	readonly visibleText: string;
	readonly priorRole: string | undefined;
	readonly hasToolCalls: boolean;
	readonly hasToolResults: boolean;
}

/** Slice 10. The session passes the turn. Length stays on compact-and-retry, so it is ignored here. */
export function recoveryForTurn(turn: RecoveryTurn, used: { empty: number; markup: number }): ResponseRecoveryDecision {
	if (turn.hasToolResults || turn.hasToolCalls) return { type: "stop" };
	return decideResponseRecovery({
		stopReason: turn.stopReason,
		visibleText: turn.visibleText,
		priorRole: turn.priorRole,
		hasToolCallMarkup: textHasUnparsedToolCall(turn.visibleText),
		truncatedContinuationsUsed: MAX_TRUNCATED_CONTINUATIONS,
		emptyContinuationsUsed: used.empty,
		markupNudgesUsed: used.markup,
	});
}

export function textHasUnparsedToolCall(text: string): boolean {
	return /<tool_call\b/i.test(text) || /```tool\b/i.test(text);
}
