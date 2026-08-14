import { describe, expect, it } from "vitest";
import { getLatestTodos, SessionManager, TODO_CUSTOM_ENTRY_TYPE } from "../../src/core/session-manager.ts";

describe("getLatestTodos (task 4.3)", () => {
	it("returns an empty list when no todo entry has ever been appended", () => {
		expect(getLatestTodos([])).toEqual([]);
	});

	it("returns the most recently appended todo snapshot, not an earlier one", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry(TODO_CUSTOM_ENTRY_TYPE, [{ content: "first", status: "pending" }]);
		session.appendCustomEntry(TODO_CUSTOM_ENTRY_TYPE, [
			{ content: "first", status: "completed" },
			{ content: "second", status: "pending" },
		]);

		expect(getLatestTodos(session.getEntries())).toEqual([
			{ content: "first", status: "completed" },
			{ content: "second", status: "pending" },
		]);
	});

	it("ignores custom entries of a different customType", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry("unrelated", { anything: true });

		expect(getLatestTodos(session.getEntries())).toEqual([]);
	});
});
