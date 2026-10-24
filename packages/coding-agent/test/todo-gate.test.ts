import { describe, expect, it } from "vitest";
import { decideTodoGate, type TodoGateItem } from "../src/core/todo-gate.ts";

function item(overrides: Partial<TodoGateItem> = {}): TodoGateItem {
	return { content: "fix the gate", status: "completed", ...overrides };
}

describe("todo completion gate", () => {
	it("does nothing when the session has no todos", () => {
		expect(decideTodoGate({ todos: [], continuationsUsed: 0 })).toEqual({ type: "stop" });
	});

	it("does nothing while any item is still open", () => {
		expect(
			decideTodoGate({
				todos: [item(), item({ content: "still going", status: "in_progress" })],
				continuationsUsed: 0,
			}),
		).toEqual({ type: "stop" });
	});

	it("continues once when every item is completed and none records a check", () => {
		const decision = decideTodoGate({ todos: [item(), item({ content: "second" })], continuationsUsed: 0 });
		expect(decision.type).toBe("continue");
		if (decision.type === "continue") {
			expect(decision.prompt).toContain("fix the gate");
			expect(decision.prompt).toContain("second");
		}
	});

	it("stops when every completed item records a check", () => {
		expect(
			decideTodoGate({
				todos: [item({ check: "npm test exited 0" })],
				continuationsUsed: 0,
			}),
		).toEqual({ type: "stop" });
	});

	it("does not continue a second time", () => {
		expect(decideTodoGate({ todos: [item()], continuationsUsed: 1 })).toEqual({ type: "stop" });
	});
});
