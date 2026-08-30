import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentTool } from "apex-code-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createLargeResultTool(onExecute?: () => void, resultCharacters = 400): AgentTool {
	return {
		name: "large_result",
		label: "Large result",
		description: "Return enough context to cross the compaction threshold",
		parameters: Type.Object({}),
		execute: async () => {
			onExecute?.();
			return {
				content: [{ type: "text", text: `large-result-marker:${"x".repeat(resultCharacters)}` }],
				details: {},
			};
		},
	};
}

describe("issue #6879: mid-run threshold auto-compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("compacts after a completed tool batch before the next provider request, then resumes", async () => {
		const timeline: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 4_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 3_400, keepRecentTokens: 120 } },
			tools: [createLargeResultTool(() => timeline.push("tool-complete"))],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted old history",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") timeline.push(`compact-${event.reason}`);
		});

		harness.setResponses([
			fauxAssistantMessage("old-history-marker"),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				timeline.push("resumed-provider-request");
				const serializedContext = JSON.stringify(context.messages);
				expect(serializedContext).toContain("large-result-marker");
				return fauxAssistantMessage("finished after compaction");
			},
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("run the large tool and finish the task");

		expect(timeline.slice(0, 3)).toEqual(["tool-complete", "compact-threshold", "resumed-provider-request"]);
		expect(timeline.filter((event) => event === "compact-threshold")).toHaveLength(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(2);
		expect(harness.session.getLastAssistantText()).toBe("finished after compaction");
	});

	it("does not send another provider request when mid-run compaction cannot start", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 4_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 3_400, keepRecentTokens: 1 } },
			tools: [createLargeResultTool(undefined, 4_000)],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not be requested"),
		]);

		await harness.session.prompt("run the large tool");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.session.messages.at(-1)?.role).toBe("toolResult");
	});

	it("preserves an existing host stop decision", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 4_000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 3_400, keepRecentTokens: 120 } },
			tools: [createLargeResultTool()],
			shouldStopAfterTurn: async () => true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("must not be requested"),
		]);

		await harness.session.prompt("run the large tool");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});
});
