import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	createTodoWriteTool,
	createTodoWriteToolDefinition,
	type TodoItem,
	type TodoWriteStore,
} from "../../src/core/tools/todo-write.ts";

function createRecordingStore(): TodoWriteStore & { writes: TodoItem[][] } {
	const writes: TodoItem[][] = [];
	return {
		writes,
		write: (todos) => {
			writes.push(todos);
		},
	};
}

describe("todo_write contract (task 4.3)", () => {
	it("declares the state capability, allow default, a null ruleForCall, deferred schema, and no evidence", () => {
		const definition = createTodoWriteToolDefinition(createRecordingStore());
		expect([...definition.contract.capabilities]).toEqual(["state"]);
		expect(definition.contract.permission.defaultBehavior).toBe("allow");
		expect(definition.contract.permission.ruleForCall({ todos: [{ content: "x", status: "pending" }] })).toBeNull();
		expect(definition.contract.context.deferSchema).toBe(true);
		expect(definition.contract.evidence.emits.size).toBe(0);
	});

	it("never matches any rule content, since ruleForCall never generates one", () => {
		const definition = createTodoWriteToolDefinition(createRecordingStore());
		expect(definition.contract.permission.matches("**", { todos: [{ content: "x", status: "pending" }] })).toBe(
			false,
		);
	});
});

describe("todo_write execution (task 4.3)", () => {
	it("persists the full submitted list to the store and echoes it back in details", async () => {
		const store = createRecordingStore();
		const tool = createTodoWriteTool(store);
		const todos: TodoItem[] = [
			{ content: "Write the spec", status: "completed" },
			{ content: "Implement the tool", status: "in_progress" },
			{ content: "Wire up the registry", status: "pending" },
		];

		const result = await tool.execute("call-1", { todos });

		expect(store.writes).toEqual([todos]);
		expect(result.details).toEqual({ todos });
		expect(result.content[0]).toMatchObject({ type: "text" });
	});

	it("replaces the previous list entirely -- an empty array clears it", async () => {
		const store = createRecordingStore();
		const tool = createTodoWriteTool(store);

		await tool.execute("call-1", { todos: [{ content: "one task", status: "pending" }] });
		await tool.execute("call-2", { todos: [] });

		expect(store.writes).toEqual([[{ content: "one task", status: "pending" }], []]);
	});

	it("summarizes the counts of each status in the result text", async () => {
		const store = createRecordingStore();
		const tool = createTodoWriteTool(store);
		const result = await tool.execute("call-1", {
			todos: [
				{ content: "a", status: "completed" },
				{ content: "b", status: "in_progress" },
				{ content: "c", status: "pending" },
				{ content: "d", status: "pending" },
			],
		});

		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toMatch(/1.*completed/i);
		expect(text).toMatch(/1.*in_progress/i);
		expect(text).toMatch(/2.*pending/i);
	});
});

describe("todo_write parameter schema rejects malformed input (task 4.3)", () => {
	it("rejects a todo with an unknown status", () => {
		const definition = createTodoWriteToolDefinition(createRecordingStore());
		const invalid = { todos: [{ content: "x", status: "archived" }] };
		expect(Value.Check(definition.parameters, invalid)).toBe(false);
	});

	it("rejects a todo missing its content field", () => {
		const definition = createTodoWriteToolDefinition(createRecordingStore());
		const invalid = { todos: [{ status: "pending" }] };
		expect(Value.Check(definition.parameters, invalid)).toBe(false);
	});

	it("accepts a well-formed list, including the empty list", () => {
		const definition = createTodoWriteToolDefinition(createRecordingStore());
		expect(Value.Check(definition.parameters, { todos: [] })).toBe(true);
		expect(Value.Check(definition.parameters, { todos: [{ content: "x", status: "pending" }] })).toBe(true);
	});
});
