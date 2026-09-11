import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type StreamFn } from "../src/index.ts";
import { createCompositeBudgetController, createRunBudgetController } from "../src/run-budget.ts";

// Mock stream that mimics AssistantMessageEventStream (same shape as agent.test.ts)
class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** One completed assistant response per provider request, counting requests. */
function scriptedStreamFn(texts: string[]): { streamFn: StreamFn; sent: { count: number } } {
	let index = 0;
	const sent = { count: 0 };
	const streamFn: StreamFn = () => {
		const text = texts[Math.min(index, texts.length - 1)]!;
		index++;
		sent.count = index;
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: assistantMessage(text) });
		});
		return stream;
	};
	return { streamFn, sent };
}

type AgentEndEvent = Extract<AgentEvent, { type: "agent_end" }>;

function collectAgentEnds(agent: Agent): AgentEndEvent[] {
	const ends: AgentEndEvent[] = [];
	agent.subscribe((event) => {
		if (event.type === "agent_end") ends.push(event);
	});
	return ends;
}

describe("run budget scope (Agent option)", () => {
	it("prompt scope (the default) restarts the budget on every prompt()", async () => {
		const { streamFn, sent } = scriptedStreamFn(["first", "second"]);
		const agent = new Agent({ streamFn, runBudget: { maxProviderRequests: 1 } });
		const ends = collectAgentEnds(agent);

		await agent.prompt("one");
		await agent.prompt("two");

		// Upstream semantics preserved: each prompt is a fresh logical run, so
		// both runs get their own request budget and both send.
		expect(sent.count).toBe(2);
		expect(ends[1]?.stopReason).toEqual({ kind: "completed" });
	});

	it("session scope keeps one controller across prompt() calls", async () => {
		const { streamFn, sent } = scriptedStreamFn(["first", "second"]);
		const agent = new Agent({
			streamFn,
			runBudget: { maxProviderRequests: 1 },
			budgetScope: "session",
		});
		const ends = collectAgentEnds(agent);

		await agent.prompt("one");
		expect(sent.count).toBe(1);
		expect(ends[0]?.stopReason).toEqual({ kind: "completed" });

		// The second prompt continues the same budget: it is refused at the gate
		// before any provider request fires.
		await agent.prompt("two");
		expect(sent.count).toBe(1);
		expect(ends[1]?.stopReason).toEqual({ kind: "budget-exhausted", limit: "provider-requests" });
	});

	it("a shared controller gates every prompt and is never reset by one", async () => {
		const { streamFn, sent } = scriptedStreamFn(["first", "second"]);
		const shared = createRunBudgetController({ maxProviderRequests: 1 });
		const agent = new Agent({ streamFn, sharedBudgetController: shared });

		await agent.prompt("one");
		expect(sent.count).toBe(1);

		await agent.prompt("two");
		expect(sent.count).toBe(1);
		expect(shared.exhaustedLimit()).toBe("provider-requests");
	});

	it("session scope composes the local policy with the shared controller", async () => {
		const { streamFn, sent } = scriptedStreamFn(["first", "second", "third"]);
		const shared = createRunBudgetController({ maxProviderRequests: 2 });
		const agent = new Agent({
			streamFn,
			runBudget: { maxProviderRequests: 5 },
			budgetScope: "session",
			sharedBudgetController: shared,
		});

		await agent.prompt("one");
		await agent.prompt("two");
		expect(sent.count).toBe(2);

		// The local budget (2 of 5) still allows; the shared family ceiling (2 of
		// 2) refuses, so no request fires.
		await agent.prompt("three");
		expect(sent.count).toBe(2);
		expect(shared.exhaustedLimit()).toBe("provider-requests");
	});
});

describe("createCompositeBudgetController", () => {
	it("allows only when both allow, and a refusal consumes neither counter", () => {
		const primary = createRunBudgetController({ maxProviderRequests: 2 });
		const shared = createRunBudgetController({ maxProviderRequests: 1 });
		const composite = createCompositeBudgetController(primary, shared);

		expect(composite.tryBeginProviderRequest()).toBe(true);
		expect(primary.exhaustedLimit()).toBeUndefined();
		expect(shared.exhaustedLimit()).toBe("provider-requests");

		expect(composite.tryBeginProviderRequest()).toBe(false);
		// The refused attempt is recorded nowhere: the primary still has one left.
		expect(primary.tryBeginProviderRequest()).toBe(true);
	});

	it("does not consume the shared controller when the primary refuses", () => {
		const primary = createRunBudgetController({ maxProviderRequests: 1 });
		const shared = createRunBudgetController({ maxProviderRequests: 5 });
		const composite = createCompositeBudgetController(primary, shared);

		expect(composite.tryBeginProviderRequest()).toBe(true);
		expect(composite.tryBeginProviderRequest()).toBe(false);
		expect(shared.exhaustedLimit()).toBeUndefined();
	});

	it("keeps the already-sent-request boundary for tool calls", () => {
		const primary = createRunBudgetController({ maxProviderRequests: 1, maxToolCalls: 1 });
		const shared = createRunBudgetController({ maxProviderRequests: 1, maxToolCalls: 1 });
		const composite = createCompositeBudgetController(primary, shared);

		expect(composite.tryBeginProviderRequest()).toBe(true);
		// Both controllers are exhausted on provider requests, but the batch
		// belonging to the already-sent request must still complete.
		expect(composite.tryAcceptToolCall()).toBe(true);
		expect(composite.exhaustedLimit()).toBe("provider-requests");
		// The next batch's call is refused at the tool-call limit.
		expect(composite.tryAcceptToolCall()).toBe(false);
	});

	it("blocks tool calls at either controller's wall-time limit (fake now)", () => {
		let nowMs = 1_000;
		const primary = createRunBudgetController({ maxToolCalls: 2, maxWallTimeMs: 10_000 }, { now: () => nowMs });
		const shared = createRunBudgetController({ maxToolCalls: 5, maxWallTimeMs: 500 }, { now: () => nowMs });
		const composite = createCompositeBudgetController(primary, shared);

		expect(composite.tryAcceptToolCall()).toBe(true);

		// Past the shared wall-time limit, inside the primary's.
		nowMs = 1_600;
		expect(composite.exhaustedLimit()).toBe("wall-time");
		expect(composite.tryAcceptToolCall()).toBe(false);
		// The refused attempt consumed nothing on the primary: it still has one
		// of its two tool calls left.
		expect(primary.tryAcceptToolCall()).toBe(true);
	});

	it("names the primary's exhausted limit first", () => {
		const primary = createRunBudgetController({ maxToolCalls: 1 });
		const shared = createRunBudgetController({ maxProviderRequests: 1 });
		const composite = createCompositeBudgetController(primary, shared);

		expect(composite.tryBeginProviderRequest()).toBe(true);
		expect(composite.tryAcceptToolCall()).toBe(true);

		// Both are exhausted; the child's own (primary) exhaustion is the more
		// specific diagnosis, so it names the limit.
		expect(composite.exhaustedLimit()).toBe("tool-calls");
	});

	it("records maintenance requests in both controllers", () => {
		const primary = createRunBudgetController({ maxProviderRequests: 5 });
		const shared = createRunBudgetController({ maxProviderRequests: 5 });
		const composite = createCompositeBudgetController(primary, shared);

		composite.recordMaintenanceRequest();
		composite.recordMaintenanceRequest();

		// The composite reports the sum; each underlying controller recorded both.
		expect(composite.maintenanceRequests()).toBe(4);
		expect(primary.maintenanceRequests()).toBe(2);
		expect(shared.maintenanceRequests()).toBe(2);
	});
});

describe("Agent.budgetUsage()", () => {
	it("reports the active run's counters and stays undefined before the first run", async () => {
		const { streamFn } = scriptedStreamFn(["first"]);
		const agent = new Agent({ streamFn, runBudget: { maxProviderRequests: 3 }, budgetScope: "session" });
		expect(agent.budgetUsage()).toBeUndefined();

		await agent.prompt("one");
		expect(agent.budgetUsage()).toMatchObject({ providerRequests: 1, toolCalls: 0 });

		// Session scope: the follow-up prompt continues the same controller, so
		// the counters accumulate across prompts instead of resetting.
		await agent.prompt("two");
		expect(agent.budgetUsage()).toMatchObject({ providerRequests: 2, toolCalls: 0, maintenanceRequests: 0 });
	});
});
