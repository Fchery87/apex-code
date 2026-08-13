/**
 * Tool-result eviction — Phase 3 task 3.1.
 *
 * Implements the eviction algorithm settled in `docs/architecture/contracts.md` § 2
 * ("Context pipeline order — settled"): a pure, prefix-oldest, contiguous-run
 * transform over the message list. It runs *before* compaction in the pipeline
 * order (deferred-schema resolution → eviction → compaction), but this module knows
 * nothing about that ordering or about `transformContext` — wiring is task 3.3.
 *
 * Pure by construction: no clock, no randomness, no I/O, no reads of the live tool
 * registry. Every fact this function needs about a tool comes through the injected
 * `contractLookup`, and every fact about "how big is this" comes from the message
 * content already in hand.
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "apex-code-agent-core";
import { estimateTokens } from "../compaction/compaction.ts";
import type { ToolContract } from "../tools/contract.ts";

/**
 * What `evictToolResults` needs to know about a tool's contract to decide whether
 * (and how) to evict one of its results. Only the `context` axis of `ToolContract`
 * matters here — callers may pass a full contract, or (as tests do) a hand-built
 * stand-in with just `context` filled in.
 */
export type ContractLookup = (toolName: string) => Pick<ToolContract, "context"> | undefined;

/** Marker substituted for an evicted result when its contract declares none. */
export const DEFAULT_EVICTION_MARKER = "[Tool result evicted to save context. Re-run the tool to see it again.]";

function isToolResultMessage(
	message: AgentMessage,
): message is Extract<AgentMessage, { role: "toolResult" }> {
	return message.role === "toolResult";
}

/** True when `content` is already exactly the single-text-block marker form. */
function isAlreadyEvicted(content: readonly unknown[], marker: string): boolean {
	return (
		content.length === 1 &&
		typeof content[0] === "object" &&
		content[0] !== null &&
		(content[0] as { type?: unknown }).type === "text" &&
		(content[0] as { text?: unknown }).text === marker
	);
}

/**
 * Replace the oldest contiguous run of recoverable tool results with markers, until
 * the estimated total token cost of *all* tool-result messages in the list drops to
 * or below `budget` (chars/4, the same heuristic `estimateTokens` uses elsewhere in
 * this codebase — see `core/compaction/compaction.ts`). "Contiguous run from the
 * oldest end" is enforced by walking messages in order and stopping the walk for
 * good — not just skipping — the moment a tool result is encountered whose contract
 * says it is not recoverable (or has no contract at all, matching the `UNCLASSIFIED`
 * default of `resultRecoverable: false`): later eligible results are never reached,
 * so no hole ever opens in the middle of the transcript. Non-tool-result messages
 * (assistant/user turns) are passed through untouched and do not interrupt or count
 * toward the walk.
 *
 * Deterministic and idempotent: a message whose content already exactly equals its
 * tool's marker is recognized as already evicted and left alone, so re-running this
 * function over its own output (or over a budget that is already satisfied) is a
 * no-op. Never mutates `messages` or any message object — always returns a new
 * array; unevicted messages keep their original object identity (unmutated sharing
 * is not mutation), evicted ones are new objects with only `content` replaced.
 */
export function evictToolResults(
	messages: readonly AgentMessage[],
	contractLookup: ContractLookup,
	budget: number,
): AgentMessage[] {
	let remaining = 0;
	for (const message of messages) {
		if (isToolResultMessage(message)) remaining += estimateTokens(message);
	}

	const result: AgentMessage[] = [];
	let stopped = false;

	for (const message of messages) {
		if (stopped || !isToolResultMessage(message) || remaining <= budget) {
			result.push(message);
			continue;
		}

		const contract = contractLookup(message.toolName);
		const recoverable = contract?.context.resultRecoverable === true;
		if (!recoverable) {
			stopped = true;
			result.push(message);
			continue;
		}

		const marker = contract.context.evictionMarker ?? DEFAULT_EVICTION_MARKER;
		if (isAlreadyEvicted(message.content, marker)) {
			result.push(message);
			continue;
		}

		const before = estimateTokens(message);
		const markerContent: TextContent[] = [{ type: "text", text: marker }];
		const evicted = { ...message, content: markerContent };
		const after = estimateTokens(evicted);
		remaining = remaining - before + after;
		result.push(evicted);
	}

	return result;
}
