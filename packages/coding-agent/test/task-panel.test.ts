import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { TaskPanelComponent, type TaskPanelSession } from "../src/modes/interactive/components/task-panel.ts";
import { rmScratchResilient, scratchDir } from "./suite/scratch.ts";

let cwd: string;
let previousCwd: string;
beforeEach(async () => {
	cwd = await scratchDir("apex-tasks-");
	previousCwd = process.cwd();
	process.chdir(cwd);
});
afterEach(async () => {
	process.chdir(previousCwd);
	await rmScratchResilient(cwd);
});
function setup() {
	const manager = SessionManager.inMemory(cwd);
	const settings = SettingsManager.inMemory();
	let active = ["todo_write"];
	let streaming = false;
	let session: TaskPanelSession = {
		sessionManager: manager,
		getActiveToolNames: () => active,
		get isStreaming() {
			return streaming;
		},
	};
	const panel = new TaskPanelComponent({ getSession: () => session, getSettings: () => settings });
	return {
		manager,
		settings,
		panel,
		setStreaming: (active: boolean) => {
			streaming = active;
		},
		setActive: (names: string[]) => {
			active = names;
		},
		replace: (replacement: TaskPanelSession) => {
			session = replacement;
		},
		session,
	};
}
const tasks = [
	{ content: "Read", status: "completed" },
	{ content: "Implement", status: "in_progress" },
	...Array.from({ length: 4 }, (_, i) => ({ content: `Task ${i}`, status: "pending" })),
];
describe("pinned task panel", () => {
	it("shows count and current task, caps expanded rows and persists preference", () => {
		const { manager, panel, settings } = setup();
		manager.appendCustomEntry("todo", tasks);
		expect(panel.render(80)).toEqual(["Tasks 1/6 · Implement"]);
		panel.toggle();
		expect(settings.getTaskPanelExpanded()).toBe(true);
		expect(panel.render(80)).toEqual(["✓ Read", "› Implement", "○ Task 0", "○ Task 1", "○ Task 2", "+1 more"]);
	});
	it("gates actual loadout and caches branch snapshots between frames", () => {
		const { manager, panel, setActive } = setup();
		manager.appendCustomEntry("todo", tasks);
		const read = vi.spyOn(manager, "getBranch");
		panel.render(80);
		panel.render(80);
		expect(read).toHaveBeenCalledTimes(1);
		setActive([]);
		expect(panel.render(80)).toEqual([]);
		setActive(["todo_write"]);
		expect(panel.render(80)).toEqual(["Tasks 1/6 · Implement"]);
		manager.appendCustomEntry("todo", []);
		expect(panel.render(80)).toEqual([]);
	});
	it("retains newly completed tasks until settled across retry and never resurrects old complete tasks", () => {
		const { manager, panel } = setup();
		manager.appendCustomEntry("todo", tasks);
		panel.render(80);
		panel.handleEvent({ type: "agent_start" });
		manager.appendCustomEntry("todo", [{ content: "Done", status: "completed" }]);
		expect(panel.render(80)).toEqual(["Tasks 1/1"]);
		panel.handleEvent({ type: "agent_end" });
		expect(panel.render(80)).toEqual(["Tasks 1/1"]);
		panel.handleEvent({ type: "agent_settled" });
		expect(panel.render(80)).toEqual([]);
		panel.handleEvent({ type: "agent_start" });
		expect(panel.render(80)).toEqual([]);
	});
	it("follows direct branch navigation, empty replacements and new session identities", () => {
		const { manager, panel, replace } = setup();
		const first = manager.appendCustomEntry("todo", tasks);
		manager.appendCustomEntry("todo", []);
		expect(panel.render(80)).toEqual([]);
		manager.branch(first);
		expect(panel.render(80)).toEqual(["Tasks 1/6 · Implement"]);
		const other = SessionManager.inMemory(cwd);
		other.appendCustomEntry("todo", [{ content: "Other", status: "in_progress" }]);
		replace({ sessionManager: other, getActiveToolNames: () => ["todo_write"], isStreaming: false });
		expect(panel.render(80)).toEqual(["Tasks 0/1 · Other"]);
	});
	it("uses existing lifecycle authority when the same session rebinds after a missed settled event", () => {
		const { manager, panel, setStreaming } = setup();
		manager.appendCustomEntry("todo", tasks);
		panel.render(80);
		setStreaming(true);
		panel.handleEvent({ type: "agent_start" });
		manager.appendCustomEntry("todo", [{ content: "Done", status: "completed" }]);
		expect(panel.render(80)).toEqual(["Tasks 1/1"]);
		panel.rebind();
		expect(panel.render(80)).toEqual(["Tasks 1/1"]);
		setStreaming(false);
		panel.rebind();
		expect(panel.render(80)).toEqual([]);
	});

	it("rejects malformed imported rows and bounds sanitized text by terminal columns", () => {
		const { manager, panel } = setup();
		manager.appendCustomEntry("todo", { wrong: [] });
		expect(panel.render(80)).toEqual([]);
		manager.appendCustomEntry("todo", [
			null,
			{ content: 3, status: "pending" },
			{ content: "bad", status: "unknown" },
			{ content: "\u001b[31m界\n\rhello\u0007", status: "in_progress" },
		]);
		for (const width of [0, 1, 2, 8, 80]) {
			const lines = panel.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width && !/[\x00-\x1f\x7f]/.test(line))).toBe(true);
		}
		panel.toggle();
		expect(panel.render(80)).toEqual(["› 界 hello"]);
	});
});
