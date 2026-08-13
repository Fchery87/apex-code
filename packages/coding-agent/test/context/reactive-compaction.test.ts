import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createHarness } from "../test-harness.ts";

/**
 * Task 3.4: "reactive compaction on provider `prompt_too_long`, distinct from the
 * threshold path."
 *
 * Investigation for this task found the behavior already exists, inherited from
 * upstream Pi (`a38e61909`, pre-fork): `isContextOverflow()`
 * (`packages/ai/src/utils/overflow.ts`) detects real provider overflow errors across
 * ~20 providers, and `_checkCompaction` in `agent-session.ts` branches on it with its
 * own `reason: "overflow"`, wired independently of the token-count-based `"threshold"`
 * branch below it in the same function. No new production code was needed for Phase 3.
 *
 * This test is the one thing that was actually missing: a single, crisp, independent
 * pin proving the two paths are distinct — overflow fires purely off a provider error
 * message, with `reserveTokens` configured so high that `shouldCompact()`'s own
 * threshold could not have fired on its own. See docs/specs/2026-08-13-context-
 * engineering.md's corrected "Current state" section.
 */
describe("reactive compaction on provider overflow (task 3.4)", () => {
	it('compacts with reason "overflow" on a provider prompt-too-long error, even though the threshold was never crossed', async () => {
		const harness = await createHarness({
			contextWindow: 200_000,
			// The default reserveTokens (16384) keeps shouldCompact()'s own threshold
			// (contextWindow - reserveTokens = 183,616) far above this test's tiny seeded
			// history, so any compaction observed here cannot be threshold-triggered.
			// keepRecentTokens: 1 gives prepareCompaction() real content to cut once
			// overflow fires (prepareCompaction is keyed off keepRecentTokens only, not
			// reserveTokens/contextWindow).
			settings: { compaction: { keepRecentTokens: 1 } },
		});

		try {
			const model = harness.session.model!;
			const now = Date.now();

			// Pre-seed one prior turn, same technique as
			// agent-session-auto-compaction-queue.test.ts: prepareCompaction() needs real
			// history before a cut point to find anything to summarize.
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "message to compact" }],
				timestamp: now - 1000,
			});
			harness.sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "assistant response to compact" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 100,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: now - 500,
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

			// First call: a real Anthropic overflow message (matched by OVERFLOW_PATTERNS
			// in packages/ai/src/utils/overflow.ts). Every later call (the compaction's own
			// summarization request, and the retried turn after compaction) succeeds — the
			// exact count/order of those later calls is compaction's own internal business,
			// not this task's concern, so a fixed canned response covers all of them.
			let callCount = 0;
			harness.session.agent.streamFunction = (streamModel) => {
				callCount++;
				const stream = createAssistantMessageEventStream();
				void Promise.resolve().then(() => {
					if (callCount === 1) {
						stream.push({
							type: "error",
							reason: "error",
							error: {
								...fauxAssistantMessage(""),
								api: streamModel.api,
								provider: streamModel.provider,
								model: streamModel.id,
								stopReason: "error",
								errorMessage: "prompt is too long: 300000 tokens > 200000 maximum",
							},
						});
						return;
					}
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...fauxAssistantMessage("ok"),
							api: streamModel.api,
							provider: streamModel.provider,
							model: streamModel.id,
						},
					});
				});
				return stream;
			};

			await harness.session.prompt("hello");
			await harness.session.agent.waitForIdle();

			const starts = harness.eventsOfType("compaction_start");
			expect(starts.length).toBeGreaterThan(0);
			expect(starts.every((e) => e.reason === "overflow")).toBe(true);
			expect(starts.some((e) => e.reason === "threshold")).toBe(false);

			const ends = harness.eventsOfType("compaction_end");
			expect(ends.some((e) => e.reason === "overflow")).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});
