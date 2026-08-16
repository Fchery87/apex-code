import type { AgentToolResult } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import type { ApexToolDefinition } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const todoStatus = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]);

const todoItemSchema = Type.Object({
	content: Type.String({ description: "Short description of the task." }),
	status: todoStatus,
});

const todoWriteSchema = Type.Object({
	todos: Type.Array(todoItemSchema, {
		description: "The complete, updated task list. Replaces whatever list was previously recorded.",
	}),
});

export type TodoItem = Static<typeof todoItemSchema>;
export type TodoWriteInput = Static<typeof todoWriteSchema>;

export interface TodoWriteDetails {
	todos: TodoItem[];
}

export interface TodoWriteStore {
	/** Persist the full replacement task list. */
	write(todos: TodoItem[]): void;
}

function summarize(todos: TodoItem[]): string {
	if (todos.length === 0) return "Task list cleared.";
	const counts = { pending: 0, in_progress: 0, completed: 0 };
	for (const todo of todos) counts[todo.status]++;
	return `Task list updated (${todos.length} total): ${counts.pending} pending, ${counts.in_progress} in_progress, ${counts.completed} completed.`;
}

/** Create the harness-state tool that lets an agent record and update its own task list. */
export function createTodoWriteToolDefinition(
	store: TodoWriteStore,
): ApexToolDefinition<typeof todoWriteSchema, TodoWriteDetails> {
	return {
		name: "todo_write",
		label: "todo_write",
		description:
			"Record or update the current task list. Always pass the complete, updated list -- it replaces whatever was recorded before.",
		parameters: todoWriteSchema,
		contract: {
			capabilities: new Set(["state"]),
			permission: {
				defaultBehavior: "allow",
				matches: () => false,
				describe: () => "Updating the task list",
				ruleForCall: () => null,
			},
			context: { resultRecoverable: true, deferSchema: true },
			evidence: { emits: new Set(), capture: () => [] },
		},
		async execute(_toolCallId, { todos }: TodoWriteInput): Promise<AgentToolResult<TodoWriteDetails>> {
			store.write(todos);
			return {
				content: [{ type: "text", text: summarize(todos) }],
				details: { todos },
			};
		},
	};
}

export function createTodoWriteTool(store: TodoWriteStore) {
	return wrapToolDefinition(createTodoWriteToolDefinition(store));
}
