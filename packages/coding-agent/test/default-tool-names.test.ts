import { describe, expect, it } from "vitest";
import { configuredDefaultToolNames } from "../src/core/default-tool-names.ts";

describe("default active tools (HR.15)", () => {
	it("includes the search tools, web_fetch, and delegate, and leaves todo_write opt-in", () => {
		const names = configuredDefaultToolNames({});
		expect(names).toEqual(
			expect.arrayContaining(["read", "bash", "edit", "write", "grep", "find", "ls", "web_fetch", "delegate"]),
		);
	});

	it("does not default todo_write on, because the task-list setting opts a user in", () => {
		expect(configuredDefaultToolNames({})).not.toContain("todo_write");
	});

	it("still adds lsp, web_search, and mcp only when configured", () => {
		expect(configuredDefaultToolNames({})).not.toContain("lsp");
		expect(configuredDefaultToolNames({ lsp: true, webSearch: true, mcp: true })).toEqual(
			expect.arrayContaining(["lsp", "web_search", "mcp"]),
		);
	});

	it("an explicit base list is used exactly, with no additions", () => {
		expect(configuredDefaultToolNames({ baseNames: ["read"] })).toEqual(["read"]);
	});
});
