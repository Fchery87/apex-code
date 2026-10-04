import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import type { TodoItem } from "../todo-write.ts";
import type { ToolRenderers } from "./index.ts";

export function normalizeTasks(value: unknown): TodoItem[] {
	if (!Array.isArray(value)) return [];
	const items: unknown[] = value;
	const tasks: TodoItem[] = [];
	for (const item of items) {
		if (typeof item !== "object" || item === null || !("content" in item) || !("status" in item)) continue;
		if (typeof item.content !== "string") continue;
		const status = item.status;
		if (status !== "pending" && status !== "in_progress" && status !== "completed") continue;
		const content = stripAnsi(item.content)
			.replace(/\u001b(?:_|P|\^|X)[\s\S]*?(?:\u001b\\|\u009c)/g, "")
			.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		tasks.push({ content, status });
	}
	return tasks;
}
export function truncateTaskText(text: string, width: number): string {
	return stripAnsi(truncateToWidth(text, width, ""));
}
export function taskRows(tasks: TodoItem[], width: number, limit = tasks.length): string[] {
	if (width <= 0) return [];
	return tasks
		.slice(0, limit)
		.map((item) =>
			truncateTaskText(
				`${item.status === "completed" ? "✓" : item.status === "in_progress" ? "›" : "○"} ${item.content}`,
				width,
			),
		);
}
export const todoWriteRenderers: ToolRenderers = {
	renderCall(_args, theme, context) {
		const pending = new Text(theme.fg("toolTitle", "Updating task list…"), 0, 0);
		return {
			render: (width) => (context.state.taskResult ? [] : pending.render(width)),
			invalidate: () => pending.invalidate(),
		} satisfies Component;
	},
	renderResult(result, options, theme, context) {
		context.state.taskResult = true;
		if (context.isError)
			return new Text(
				theme.fg(
					"error",
					result.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("\n"),
				),
				0,
				0,
			);
		const tasks = normalizeTasks(result.details?.todos);
		const summary = `Task list updated · ${tasks.filter((item) => item.status === "completed").length}/${tasks.length} complete`;
		return {
			render: (width) =>
				width <= 0 ? [] : [truncateTaskText(summary, width), ...(options.expanded ? taskRows(tasks, width) : [])],
			invalidate() {},
		};
	},
};
