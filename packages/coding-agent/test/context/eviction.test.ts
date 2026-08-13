import { describe, expect, it } from "vitest";
import { type ContractLookup, DEFAULT_EVICTION_MARKER, evictToolResults } from "../../src/core/context/eviction.ts";

/**
 * Hand-written, hermetic fixtures. `evictToolResults` must never reach into the real
 * tool registry (see task 3.1 scope) — its contract knowledge comes entirely through
 * the injected `contractLookup`, so tests build tiny `ToolContract`-shaped stand-ins
 * (just the `context` axis) for a "read"-like recoverable tool and a "bash"-like
 * non-recoverable one.
 */

const READ_LIKE_CONTRACT = { context: { resultRecoverable: true, deferSchema: false } };
const BASH_LIKE_CONTRACT = { context: { resultRecoverable: false, deferSchema: false } };
const CUSTOM_MARKER_CONTRACT = {
	context: { resultRecoverable: true, deferSchema: false, evictionMarker: "[[gone]]" },
};

const contractLookup: ContractLookup = (toolName) => {
	switch (toolName) {
		case "read":
			return READ_LIKE_CONTRACT;
		case "bash":
			return BASH_LIKE_CONTRACT;
		case "read_custom_marker":
			return CUSTOM_MARKER_CONTRACT;
		default:
			return undefined;
	}
};

let nextTimestamp = 1_000;

function toolResult(toolName: string, toolCallId: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: nextTimestamp++,
	};
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "messages" as const,
		provider: "anthropic" as const,
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: nextTimestamp++,
	};
}

// A big enough block of filler text (400 chars ~ 100 estimated tokens at the repo's
// chars/4 heuristic) so eviction has something real to reclaim.
const BIG_TEXT = "x".repeat(400);

describe("evictToolResults", () => {
	it("evicts a recoverable (read-shaped) tool result when the budget requires it", () => {
		const messages = [toolResult("read", "call-1", BIG_TEXT)];

		const evicted = evictToolResults(messages, contractLookup, 0);

		expect(evicted).toHaveLength(1);
		expect(evicted[0]).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "read" });
		expect((evicted[0] as { content: { text: string }[] }).content).toEqual([
			{ type: "text", text: DEFAULT_EVICTION_MARKER },
		]);
	});

	it("preserves a non-recoverable (bash-shaped) tool result untouched even when eviction runs", () => {
		const messages = [toolResult("bash", "call-1", BIG_TEXT)];

		const evicted = evictToolResults(messages, contractLookup, 0);

		expect(evicted).toEqual(messages);
	});

	it("takes the oldest contiguous eligible run and never punches a hole in the middle", () => {
		// [recoverable A, non-recoverable B, recoverable C]. Evicting C alone would
		// satisfy the budget, but the walk must stop at B and leave C untouched.
		const messages = [
			toolResult("read", "call-a", BIG_TEXT),
			toolResult("bash", "call-b", BIG_TEXT),
			toolResult("read", "call-c", BIG_TEXT),
		];

		const evicted = evictToolResults(messages, contractLookup, 0);

		expect((evicted[0] as { content: { text: string }[] }).content).toEqual([
			{ type: "text", text: DEFAULT_EVICTION_MARKER },
		]);
		expect(evicted[1]).toEqual(messages[1]);
		// C is untouched — the non-recoverable B in the middle blocks the walk from
		// ever reaching it, even though the budget was not satisfied by A alone.
		expect(evicted[2]).toEqual(messages[2]);
	});

	it("stops evicting once the budget is satisfied without touching later eligible results", () => {
		const messages = [
			toolResult("read", "call-a", BIG_TEXT),
			toolResult("read", "call-b", BIG_TEXT),
		];

		// BIG_TEXT is 400 chars -> ~100 estimated tokens per raw result, ~19 for the
		// default marker. Two raw results total ~200; evicting just the first one
		// brings the total to ~119, which is under this budget but evicting neither
		// (~200) or both (~38) would not isolate the "stop after one" behavior, so the
		// budget must sit strictly between those two totals.
		const evicted = evictToolResults(messages, contractLookup, 150);

		expect((evicted[0] as { content: { text: string }[] }).content).toEqual([
			{ type: "text", text: DEFAULT_EVICTION_MARKER },
		]);
		expect(evicted[1]).toEqual(messages[1]);
	});

	it("uses a tool-declared evictionMarker when present, instead of the default", () => {
		const messages = [toolResult("read_custom_marker", "call-1", BIG_TEXT)];

		const evicted = evictToolResults(messages, contractLookup, 0);

		expect((evicted[0] as { content: { text: string }[] }).content).toEqual([{ type: "text", text: "[[gone]]" }]);
	});

	it("treats a tool with no contract entry as non-recoverable, matching the UNCLASSIFIED default", () => {
		const messages = [toolResult("mystery_tool", "call-1", BIG_TEXT)];

		const evicted = evictToolResults(messages, contractLookup, 0);

		expect(evicted).toEqual(messages);
	});

	it("leaves assistant/user messages interleaved with tool results unchanged", () => {
		const messages = [
			assistantMessage("about to call read"),
			toolResult("read", "call-a", BIG_TEXT),
			assistantMessage("about to call bash"),
			toolResult("bash", "call-b", BIG_TEXT),
		];

		const evicted = evictToolResults(messages, contractLookup, 0);

		expect(evicted[0]).toEqual(messages[0]);
		expect(evicted[2]).toEqual(messages[2]);
		expect(evicted[3]).toEqual(messages[3]);
	});

	it("is idempotent: applying it a second time to its own output changes nothing further", () => {
		const messages = [
			toolResult("read", "call-a", BIG_TEXT),
			toolResult("bash", "call-b", BIG_TEXT),
			toolResult("read", "call-c", BIG_TEXT),
		];

		const once = evictToolResults(messages, contractLookup, 0);
		const twice = evictToolResults(once, contractLookup, 0);

		expect(twice).toEqual(once);
	});

	it("does not mutate the input array or its message objects", () => {
		const messages = [toolResult("read", "call-1", BIG_TEXT)];
		const snapshot = JSON.parse(JSON.stringify(messages));

		const evicted = evictToolResults(messages, contractLookup, 0);

		expect(messages).toEqual(snapshot);
		expect(evicted).not.toBe(messages);
		expect(evicted[0]).not.toBe(messages[0]);
	});

	it("returns a new array (not the same reference) even when nothing is evicted", () => {
		const messages = [toolResult("bash", "call-1", "small")];

		const evicted = evictToolResults(messages, contractLookup, 1_000_000);

		expect(evicted).not.toBe(messages);
		expect(evicted).toEqual(messages);
	});
});
