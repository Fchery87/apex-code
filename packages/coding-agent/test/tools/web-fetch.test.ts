import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createWebFetchTool,
	createWebFetchToolDefinition,
	type WebFetchOperations,
} from "../../src/core/tools/web-fetch.ts";

function createRecordingOperations(text: string, status = 200): WebFetchOperations & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		fetch: async (url) => {
			calls.push(url);
			return { status, text };
		},
	};
}

describe("web_fetch contract (task 4.4)", () => {
	it("declares the net capability, ask default, deferred schema, and no evidence", () => {
		const definition = createWebFetchToolDefinition({ operations: createRecordingOperations("x") });
		expect([...definition.contract.capabilities]).toEqual(["net"]);
		expect(definition.contract.permission.defaultBehavior).toBe("ask");
		expect(definition.contract.context.deferSchema).toBe(true);
		expect(definition.contract.context.resultRecoverable).toBe(false);
		expect(definition.contract.evidence.emits.size).toBe(0);
	});
});

describe("web_fetch rule grammar: host + path glob (task 4.4)", () => {
	it("ruleForCall generates the exact host+path of the call, never a pattern the tool did not generate itself", () => {
		const definition = createWebFetchToolDefinition({ operations: createRecordingOperations("x") });
		const rule = definition.contract.permission.ruleForCall({ url: "https://docs.example.com/guide/intro" });
		expect(rule).toBe("docs.example.com/guide/intro");
	});

	it("an auto-generated rule matches only the exact call it came from", () => {
		const definition = createWebFetchToolDefinition({ operations: createRecordingOperations("x") });
		const rule = definition.contract.permission.ruleForCall({
			url: "https://docs.example.com/guide/intro",
		}) as string;
		expect(definition.contract.permission.matches(rule, { url: "https://docs.example.com/guide/intro" })).toBe(true);
		expect(definition.contract.permission.matches(rule, { url: "https://docs.example.com/guide/other" })).toBe(false);
		expect(definition.contract.permission.matches(rule, { url: "https://evil.example.com/guide/intro" })).toBe(false);
	});

	it("a hand-authored host+path glob (docs.example.com/**) matches anything under that host", () => {
		const definition = createWebFetchToolDefinition({ operations: createRecordingOperations("x") });
		const glob = "docs.example.com/**";
		expect(definition.contract.permission.matches(glob, { url: "https://docs.example.com/guide/intro" })).toBe(true);
		expect(definition.contract.permission.matches(glob, { url: "https://docs.example.com/" })).toBe(true);
		expect(definition.contract.permission.matches(glob, { url: "https://other.example.com/guide/intro" })).toBe(
			false,
		);
	});

	it("renders a human-readable description of the rule content", () => {
		const definition = createWebFetchToolDefinition({ operations: createRecordingOperations("x") });
		expect(definition.contract.permission.describe("docs.example.com/**")).toContain("docs.example.com/**");
	});
});

describe("web_fetch execution (task 4.4)", () => {
	it("fetches through the injected operations and returns the content plus status details", async () => {
		const ops = createRecordingOperations("hello from the page", 200);
		const tool = createWebFetchTool({ operations: ops });

		const result = await tool.execute("call-1", { url: "https://example.com/page" });

		expect(ops.calls).toEqual(["https://example.com/page"]);
		expect(result.content[0]).toMatchObject({ type: "text", text: "hello from the page" });
		expect(result.details).toMatchObject({ url: "https://example.com/page", status: 200, truncated: false });
	});

	it("truncates content larger than the output budget and records that it did", async () => {
		const bigText = "x".repeat(60 * 1024);
		const ops = createRecordingOperations(bigText, 200);
		const tool = createWebFetchTool({ operations: ops });

		const result = await tool.execute("call-1", { url: "https://example.com/big" });

		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(text.length).toBeLessThan(bigText.length);
		expect(result.details).toMatchObject({ truncated: true });
	});
});

describe("web_fetch default operations use the global, proxy-aware fetch (task 4.4)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("delegates to globalThis.fetch when no operations are injected -- these tools never bypass the sandbox's proxy-aware dispatcher", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("real fetch content", { status: 200 }));

		const tool = createWebFetchTool();
		const result = await tool.execute("call-1", { url: "https://example.com/real" });

		expect(fetchSpy).toHaveBeenCalledWith("https://example.com/real", expect.anything());
		expect(result.content[0]).toMatchObject({ type: "text", text: "real fetch content" });
	});
});
