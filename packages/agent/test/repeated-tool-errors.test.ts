import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	isRetryableAssistantError,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentEvent, AgentTool, StreamFn, ToolExecutionMode } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "fixture",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const parameters = Type.Object({ value: Type.String() });
type Call = { name: string; arguments: Record<string, unknown> };

function fixture(script: Call[][], mode: ToolExecutionMode = "sequential") {
	let requests = 0;
	const streamFn: StreamFn = () => {
		const calls = script[requests++];
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			stopReason: calls ? "toolUse" : "stop",
			content: calls
				? calls.map((call, index) => ({ type: "toolCall", id: `${requests}-${index}`, ...call }))
				: [{ type: "text", text: "done" }],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			(event) => event.type === "done" || event.type === "error",
			() => message,
		);
		queueMicrotask(() => {
			stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message });
			stream.end(message);
		});
		return stream;
	};
	const tool: AgentTool<typeof parameters> = {
		name: "probe",
		label: "probe",
		description: "fixture",
		parameters,
		async execute(_id, args) {
			if (args.value !== "success") throw new Error("Invalid operation");
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
	const agent = new Agent({ initialState: { model, tools: [tool] }, streamFn, toolExecution: mode });
	const events: AgentEvent[] = [];
	agent.subscribe((event) => {
		events.push(event);
	});
	return { agent, events, requests: () => requests };
}
const bad = { name: "probe", arguments: { value: "bad" } };
const good = { name: "probe", arguments: { value: "success" } };

describe("repeated failed tool calls", () => {
	let previousCwd: string;
	let cwd: string;
	beforeEach(() => {
		previousCwd = process.cwd();
		cwd = mkdtempSync(join(tmpdir(), "apex-error-loop-"));
		process.chdir(cwd);
	});
	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(cwd, { recursive: true, force: true });
	});

	it.each(["sequential", "parallel"] as const)("stops after three identical failures in %s mode", async (mode) => {
		const { agent, events, requests } = fixture(
			Array.from({ length: 5 }, () => [bad]),
			mode,
		);
		await agent.prompt("go");
		expect(requests()).toBe(3);
		expect(agent.state.errorMessage).toContain("3 identical");
		expect(events.at(-1)).toMatchObject({ type: "agent_end", stopReason: { kind: "error" } });
		const last = agent.state.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("Missing stop message");
		expect(last.stopReason).toBe("error");
		expect(last.usage.totalTokens).toBe(0);
		expect(isRetryableAssistantError(last)).toBe(false);
		expect(agent.state.messages.filter((m) => m.role === "toolResult")).toHaveLength(3);
	});

	it("also bounds schema validation failures", async () => {
		const { agent, requests } = fixture(Array.from({ length: 5 }, () => [{ name: "probe", arguments: {} }]));
		await agent.prompt("go");
		expect(requests()).toBe(3);
	});

	it("bounds calls to unknown tools", async () => {
		const { agent, requests } = fixture(Array.from({ length: 5 }, () => [{ ...bad, name: "missing" }]));
		await agent.prompt("go");
		expect(requests()).toBe(3);
	});

	it.each(["sequential", "parallel"] as const)("counts success anywhere in a %s batch as progress", async (mode) => {
		const { agent, requests } = fixture([[bad], [bad], [bad, good], [bad], [bad]], mode);
		await agent.prompt("go");
		expect(requests()).toBe(6);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("preserves the provider message after its message_end event", async () => {
		const { agent } = fixture([[bad], [bad], [bad]]);
		const snapshots: AssistantMessage[] = [];
		agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				snapshots.push(structuredClone(event.message));
			}
		});
		await agent.prompt("go");
		expect(agent.state.messages.filter((message) => message.role === "assistant")).toEqual(snapshots);
		expect(snapshots.slice(0, 3).every((message) => message.stopReason === "toolUse")).toBe(true);
		expect(snapshots.at(-1)?.stopReason).toBe("error");
	});

	it("compares object arguments independent of key order", async () => {
		const { agent, requests } = fixture([
			[{ name: "probe", arguments: { value: "bad", extra: { a: 1, b: 2 } } }],
			[{ name: "probe", arguments: { extra: { b: 2, a: 1 }, value: "bad" } }],
			[{ name: "probe", arguments: { value: "bad", extra: { a: 1, b: 2 } } }],
			[bad],
		]);
		await agent.prompt("go");
		expect(requests()).toBe(3);
	});

	it("resets after successful work", async () => {
		const { agent, requests } = fixture([[bad], [bad], [good], [bad], [bad]]);
		await agent.prompt("go");
		expect(requests()).toBe(6);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("detects repeated failures interleaved with another failing call", async () => {
		const other = { name: "probe", arguments: { value: "other" } };
		const { agent, requests } = fixture([[bad], [other], [bad], [other], [bad], [other]]);
		await agent.prompt("go");
		expect(requests()).toBe(5);
		expect(agent.state.errorMessage).toContain("3 identical");
	});

	it("starts fresh when the user starts another run", async () => {
		const { agent, requests } = fixture([[bad], [bad], [bad], [bad], [bad]]);
		await agent.prompt("go");
		expect(requests()).toBe(3);
		await agent.prompt("try again");
		expect(requests()).toBe(6);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("does not classify changing error output as an identical failure", async () => {
		const { agent, requests } = fixture([[bad], [bad], [bad], [bad]]);
		let failure = 0;
		agent.afterToolCall = async () => ({ content: [{ type: "text", text: `failure ${++failure}` }] });
		await agent.prompt("go");
		expect(requests()).toBe(5);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("allows different arguments to recover", async () => {
		const { agent, requests } = fixture(
			["a", "b", "c", "d"].map((value) => [{ name: "probe", arguments: { value } }]),
		);
		await agent.prompt("go");
		expect(requests()).toBe(5);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("finishes and preserves a parallel batch before stopping", async () => {
		const { agent, requests } = fixture([[bad, bad, bad, bad], [bad]], "parallel");
		await agent.prompt("go");
		expect(requests()).toBe(1);
		expect(agent.state.messages.filter((m) => m.role === "toolResult")).toHaveLength(4);
	});

	it("resets when the user steers the run", async () => {
		const { agent, requests } = fixture([[bad], [bad], [bad], [bad]]);
		let turns = 0;
		agent.subscribe((event) => {
			if (event.type === "turn_end" && ++turns === 2)
				agent.steer({ role: "user", content: "Try again", timestamp: Date.now() });
		});
		await agent.prompt("go");
		expect(requests()).toBe(5);
		expect(agent.state.errorMessage).toBeUndefined();
	});

	it("accepts steering queued on the threshold turn", async () => {
		const { agent, requests } = fixture([[bad], [bad], [bad], [bad], [bad]]);
		let turns = 0;
		agent.subscribe((event) => {
			if (event.type === "turn_end" && ++turns === 3)
				agent.steer({ role: "user", content: "Try a different approach", timestamp: Date.now() });
		});
		await agent.prompt("go");
		expect(requests()).toBe(6);
		expect(agent.state.errorMessage).toBeUndefined();
	});
});
