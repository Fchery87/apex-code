import type { Component } from "@earendil-works/pi-tui";
import type { AgentSession, AgentSessionEvent } from "../../../core/agent-session.ts";
import { getLatestTodos } from "../../../core/session-manager.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { normalizeTasks, taskRows, truncateTaskText } from "../../../core/tools/renderers/todo-write.ts";
import type { TodoItem } from "../../../core/tools/todo-write.ts";

export type TaskPanelSession = Pick<AgentSession, "sessionManager" | "getActiveToolNames" | "isStreaming">;
interface TaskPanelOptions {
	getSession(): TaskPanelSession;
	getSettings(): SettingsManager;
}
export class TaskPanelComponent implements Component {
	private readonly options: TaskPanelOptions;
	private session?: TaskPanelSession;
	private sessionId?: string;
	private leafId?: string | null;
	private todoId?: string;
	private tasks: TodoItem[] = [];
	private runActive = false;
	private retainComplete = false;
	constructor(options: TaskPanelOptions) {
		this.options = options;
	}
	invalidate(): void {}
	toggle(): void {
		const settings = this.options.getSettings();
		settings.setTaskPanelExpanded(!settings.getTaskPanelExpanded());
	}
	rebind(): void {
		const session = this.options.getSession();
		this.runActive = session.isStreaming;
		if (!this.runActive) this.retainComplete = false;
		if (session !== this.session) {
			this.session = undefined;
			this.runActive = session.isStreaming;
			this.retainComplete = false;
		}
	}
	handleEvent(event: Pick<AgentSessionEvent, "type">): void {
		this.readSnapshot();
		if (event.type === "agent_start") this.runActive = true;
		if (event.type === "agent_settled") {
			this.runActive = false;
			this.retainComplete = false;
		}
	}
	private readSnapshot(): TaskPanelSession {
		const session = this.options.getSession();
		const manager = session.sessionManager;
		const sessionId = manager.getSessionId();
		const leafId = manager.getLeafId();
		const changedSession = this.session !== session || this.sessionId !== sessionId;
		if (!changedSession && this.leafId === leafId) return session;
		if (changedSession) {
			this.runActive = session.isStreaming;
			this.retainComplete = false;
			this.todoId = undefined;
		}
		const branch = manager.getBranch();
		let todoId: string | undefined;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "custom" && entry.customType === "todo") {
				todoId = entry.id;
				break;
			}
		}
		const tasks = normalizeTasks(getLatestTodos(branch));
		if (todoId !== this.todoId) {
			this.retainComplete =
				!changedSession && this.runActive && tasks.length > 0 && tasks.every((task) => task.status === "completed");
		}
		this.session = session;
		this.sessionId = sessionId;
		this.leafId = leafId;
		this.todoId = todoId;
		this.tasks = tasks;
		return session;
	}
	render(width: number): string[] {
		const session = this.readSnapshot();
		const tasks = this.tasks;
		if (width <= 0 || !tasks.length || !session.getActiveToolNames().includes("todo_write")) return [];
		if (tasks.every((task) => task.status === "completed") && !this.retainComplete) return [];
		if (this.options.getSettings().getTaskPanelExpanded()) {
			return [
				...taskRows(tasks, width, 5),
				...(tasks.length > 5 ? [truncateTaskText(`+${tasks.length - 5} more`, width)] : []),
			];
		}
		const current = tasks.find((task) => task.status === "in_progress");
		const completed = tasks.filter((task) => task.status === "completed").length;
		return [truncateTaskText(`Tasks ${completed}/${tasks.length}${current ? ` · ${current.content}` : ""}`, width)];
	}
}
