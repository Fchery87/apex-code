/**
 * Spec 2026-10-23-coding-turn-quality.md, slice 2. A completed list with no
 * recorded check gets one more turn. An open item, an empty list, and a
 * second ask all stop.
 */

export interface TodoGateItem {
	readonly content: string;
	readonly status: "pending" | "in_progress" | "completed";
	readonly check?: string;
}

export interface TodoGateInput {
	readonly todos: readonly TodoGateItem[];
	readonly continuationsUsed: number;
}

export type TodoGateDecision = { readonly type: "stop" } | { readonly type: "continue"; readonly prompt: string };

export function decideTodoGate(input: TodoGateInput): TodoGateDecision {
	if (input.todos.length === 0) return { type: "stop" };
	if (input.todos.some((todo) => todo.status !== "completed")) return { type: "stop" };
	if (input.continuationsUsed >= 1) return { type: "stop" };
	const missing = input.todos.filter((todo) => !todo.check?.trim());
	if (missing.length === 0) return { type: "stop" };
	const names = missing.map((todo) => todo.content).join(", ");
	return {
		type: "continue",
		prompt: `The task list is marked complete, but these items have no recorded check: ${names}. For each one, record the command or observation and its result with todo_write before you answer the user. Do not address the user yet.`,
	};
}
