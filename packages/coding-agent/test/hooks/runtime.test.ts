import { describe, expect, it } from "vitest";
import { createHookRuntime, type RuntimeHookEntry } from "../../src/core/hooks/runtime.ts";
import type { HookEventPayload, HookHandler, HookOutcome } from "../../src/core/hooks/types.ts";

/** A handler that records the payloads it saw and replays canned outcomes in order. */
function scriptedHandler(
	outcomes: HookOutcome[],
	seen?: HookEventPayload[],
	matches?: (toolName: string) => boolean,
): HookHandler {
	return {
		matchesTool: matches,
		async execute(payload) {
			seen?.push(payload);
			return outcomes.shift() ?? { ok: true };
		},
	};
}

const call = (toolName = "bash"): HookEventPayload => ({ type: "tool_call", toolName, toolCallId: "t1" });

function entry(
	outcomes: HookOutcome[],
	seen?: HookEventPayload[],
	matches?: (toolName: string) => boolean,
): RuntimeHookEntry {
	return { event: "tool_call", handler: scriptedHandler(outcomes, seen, matches) };
}

describe("hook runtime matcher filtering", () => {
	it("runs a handler only when its matcher accepts the tool name", async () => {
		const seen: HookEventPayload[] = [];
		const runtime = createHookRuntime([
			entry([{ ok: true, decision: { decision: "block", reason: "no" } }], seen, (name) => name === "bash"),
		]);

		const blocked = await runtime.decideToolCall("bash", call("bash"));
		expect(blocked).toEqual({ block: true, reason: "no" });

		const untouched = await runtime.decideToolCall("read", call("read"));
		expect(untouched).toBeUndefined();
		expect(seen).toHaveLength(1);
	});

	it("treats a handler without a matcher as matching every tool", async () => {
		const seen: HookEventPayload[] = [];
		const runtime = createHookRuntime([entry([{ ok: true }], seen)]);

		await runtime.decideToolCall("read", call("read"));
		await runtime.decideToolCall("edit", call("edit"));
		expect(seen).toHaveLength(2);
	});
});

describe("hook runtime restriction-only decisions", () => {
	it("falls through to the gate on allow and on ask", async () => {
		const runtime = createHookRuntime([
			entry([{ ok: true, decision: { decision: "allow" } }]),
			entry([{ ok: true, decision: { decision: "ask" } }]),
		]);

		expect(await runtime.decideToolCall("bash", call())).toBeUndefined();
		expect(await runtime.decideToolCall("bash", call())).toBeUndefined();
	});

	it("falls through on a handler that returns no decision", async () => {
		const runtime = createHookRuntime([entry([{ ok: true }])]);
		expect(await runtime.decideToolCall("bash", call())).toBeUndefined();
	});

	it("fails closed when a handler fails or times out", async () => {
		const runtime = createHookRuntime([
			{ event: "tool_call", handler: { execute: async () => ({ ok: false, warning: "timed out" }) } },
		]);

		const result = await runtime.decideToolCall("bash", call());
		expect(result).toEqual({ block: true, reason: "timed out" });
	});

	it("short-circuits on the first block and does not run later handlers", async () => {
		const firstSeen: HookEventPayload[] = [];
		const secondSeen: HookEventPayload[] = [];
		const runtime = createHookRuntime([
			entry([{ ok: true, decision: { decision: "block", reason: "first" } }], firstSeen),
			entry([{ ok: true, decision: { decision: "block", reason: "second" } }], secondSeen),
		]);

		const result = await runtime.decideToolCall("bash", call());
		expect(result).toEqual({ block: true, reason: "first" });
		expect(firstSeen).toHaveLength(1);
		expect(secondSeen).toHaveLength(0);
	});
});

describe("hook runtime observe-only emission", () => {
	it("awaits lifecycle handlers and never surfaces a decision", async () => {
		const seen: HookEventPayload[] = [];
		const runtime = createHookRuntime([{ event: "turn_end", handler: scriptedHandler([{ ok: true }], seen) }]);

		await runtime.emitObserve("turn_end", { type: "turn_end" });
		expect(seen).toEqual([{ type: "turn_end" }]);
	});

	it("swallows handler failures on observe-only events", async () => {
		const runtime = createHookRuntime([
			{ event: "session_start", handler: { execute: async () => ({ ok: false, warning: "webhook down" }) } },
		]);

		await expect(runtime.emitObserve("session_start", { type: "session_start" })).resolves.toBeUndefined();
	});

	it("reports which events have handlers", () => {
		const runtime = createHookRuntime([
			{ event: "session_before_compact", handler: { execute: async () => ({ ok: true }) } },
		]);

		expect(runtime.hasHandlers("session_before_compact")).toBe(true);
		expect(runtime.hasHandlers("tool_call")).toBe(false);
	});
});
