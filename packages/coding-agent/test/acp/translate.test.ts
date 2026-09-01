import { describe, expect, it } from "vitest";
import { toolKind, translateJsonEvent } from "../../src/modes/acp/translate.ts";

describe("toolKind", () => {
	it("maps known tools to ACP kinds", () => {
		expect(toolKind("read")).toBe("read");
		expect(toolKind("edit")).toBe("edit");
		expect(toolKind("write")).toBe("edit");
		expect(toolKind("bash")).toBe("execute");
		expect(toolKind("powershell")).toBe("execute");
		expect(toolKind("grep")).toBe("search");
		expect(toolKind("web_fetch")).toBe("fetch");
		expect(toolKind("todo_write")).toBe("other");
	});
});

describe("translateJsonEvent", () => {
	it("maps text deltas to agent_message_chunk", () => {
		const translated = translateJsonEvent({
			type: "message_update",
			partial: { type: "text_delta", contentIndex: 0, delta: "hello world" },
		} as never);

		expect(translated).toEqual({
			kind: "message",
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello world" } },
		});
	});

	it("maps toolcall_start to a pending tool_call with the ACP kind", () => {
		const translated = translateJsonEvent({
			type: "message_update",
			partial: { type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "bash" },
		} as never);

		expect(translated).toEqual({
			kind: "tool",
			toolCallId: "call_1",
			update: { toolCallId: "call_1", title: "bash", kind: "execute", status: "pending" },
		});
	});

	it("maps toolcall completion to a completed tool_call_update", () => {
		const translated = translateJsonEvent({
			type: "message_update",
			partial: { type: "toolcall_finish", contentIndex: 1, id: "call_1" },
		} as never);

		expect(translated).toEqual({
			kind: "tool",
			toolCallId: "call_1",
			update: { toolCallId: "call_1", status: "completed" },
		});
	});

	it("ignores events it does not translate", () => {
		expect(translateJsonEvent({ type: "agent_settled" } as never)).toBeUndefined();
		expect(
			translateJsonEvent({ type: "message_update", partial: { type: "thinking_delta", delta: "hmm" } } as never),
		).toBeUndefined();
	});
});
