import { describe, expect, it } from "vitest";
import {
	createWebSearchTool,
	createWebSearchToolDefinition,
	type WebSearchOperations,
	type WebSearchResult,
} from "../../src/core/tools/web-search.ts";

function createRecordingOperations(results: WebSearchResult[]): WebSearchOperations & { queries: string[] } {
	const queries: string[] = [];
	return {
		queries,
		search: async (query) => {
			queries.push(query);
			return results;
		},
	};
}

describe("web_search contract (task 4.4)", () => {
	it("declares the net capability, ask default, deferred schema, and no evidence", () => {
		const definition = createWebSearchToolDefinition({ operations: createRecordingOperations([]) });
		expect([...definition.contract.capabilities]).toEqual(["net"]);
		expect(definition.contract.permission.defaultBehavior).toBe("ask");
		expect(definition.contract.context.deferSchema).toBe(true);
		expect(definition.contract.context.resultRecoverable).toBe(false);
		expect(definition.contract.evidence.emits.size).toBe(0);
	});
});

describe("web_search rule grammar: no per-call rule, only a blanket '*' is meaningful (task 4.4)", () => {
	it("ruleForCall always returns null -- a query is not a generalizable rule", () => {
		const definition = createWebSearchToolDefinition({ operations: createRecordingOperations([]) });
		expect(definition.contract.permission.ruleForCall({ query: "typescript generics" })).toBeNull();
		expect(definition.contract.permission.ruleForCall({ query: "anything else" })).toBeNull();
	});

	it("matches only the literal '*' rule content, never a query substring", () => {
		const definition = createWebSearchToolDefinition({ operations: createRecordingOperations([]) });
		expect(definition.contract.permission.matches("*", { query: "typescript generics" })).toBe(true);
		expect(definition.contract.permission.matches("typescript", { query: "typescript generics" })).toBe(false);
		expect(definition.contract.permission.matches("**", { query: "typescript generics" })).toBe(false);
	});

	it("renders a human-readable description", () => {
		const definition = createWebSearchToolDefinition({ operations: createRecordingOperations([]) });
		expect(definition.contract.permission.describe("*")).toContain("Web search");
	});
});

describe("web_search execution (task 4.4)", () => {
	it("searches through the injected operations and returns results in details", async () => {
		const results: WebSearchResult[] = [
			{ title: "TypeScript Handbook", url: "https://www.typescriptlang.org/docs/", snippet: "The TypeScript docs." },
		];
		const ops = createRecordingOperations(results);
		const tool = createWebSearchTool({ operations: ops });

		const result = await tool.execute("call-1", { query: "typescript generics" });

		expect(ops.queries).toEqual(["typescript generics"]);
		expect(result.details).toEqual({ results });
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("TypeScript Handbook");
	});

	it("reports zero results clearly rather than an empty string", async () => {
		const ops = createRecordingOperations([]);
		const tool = createWebSearchTool({ operations: ops });

		const result = await tool.execute("call-1", { query: "no matches for this" });

		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text).toMatch(/no results/i);
	});
});

describe("web_search default operations (task 4.4)", () => {
	it("fails clearly when no search provider has been configured, rather than silently no-oping", async () => {
		const tool = createWebSearchTool();
		await expect(tool.execute("call-1", { query: "anything" })).rejects.toThrow(/not configured/i);
	});
});
