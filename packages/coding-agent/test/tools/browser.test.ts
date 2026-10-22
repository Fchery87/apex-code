import { describe, expect, it } from "vitest";
import {
	type BrowserOperations,
	createBrowserTool,
	createBrowserToolDefinition,
} from "../../src/core/tools/browser.ts";

function recordingOperations(page: {
	title: string;
	finalUrl: string;
	console: string[];
	screenshot?: Uint8Array;
}): BrowserOperations & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		open: async (url) => {
			calls.push(url);
			return page;
		},
	};
}

describe("browser contract", () => {
	it("declares net, ask, a deferred schema, and no evidence", () => {
		const definition = createBrowserToolDefinition({
			operations: recordingOperations({ title: "", finalUrl: "", console: [] }),
		});
		expect([...definition.contract.capabilities]).toEqual(["net"]);
		expect(definition.contract.permission.defaultBehavior).toBe("ask");
		expect(definition.contract.context.deferSchema).toBe(true);
		expect(definition.contract.context.resultRecoverable).toBe(false);
		expect(definition.contract.evidence.emits.size).toBe(0);
	});

	it("builds a host and path rule the same way web_fetch does", () => {
		const definition = createBrowserToolDefinition({
			operations: recordingOperations({ title: "", finalUrl: "", console: [] }),
		});
		expect(definition.contract.permission.ruleForCall({ url: "http://127.0.0.1:3000/app" })).toBe("127.0.0.1/app");
	});
});

describe("browser execution", () => {
	it("returns the title, console, and screenshot for a loopback URL", async () => {
		const ops = recordingOperations({
			title: "Inbox",
			finalUrl: "http://127.0.0.1:3000/",
			console: ["app ready"],
			screenshot: new Uint8Array([1, 2, 3]),
		});
		const tool = createBrowserTool({ operations: ops });

		const result = await tool.execute("call-1", { url: "http://127.0.0.1:3000/" });

		expect(ops.calls).toEqual(["http://127.0.0.1:3000/"]);
		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		expect(text).toContain("Inbox");
		expect(text).toContain("app ready");
		expect(result.content.some((block) => block.type === "image")).toBe(true);
	});

	it("refuses a non-loopback URL without calling the operation", async () => {
		const ops = recordingOperations({ title: "", finalUrl: "", console: [] });
		const tool = createBrowserTool({ operations: ops });

		const result = await tool.execute("call-1", { url: "http://example.com/" });

		expect(ops.calls).toEqual([]);
		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		expect(text).toMatch(/refused/);
	});

	it("reports a missing screenshot as text when the page loaded", async () => {
		const ops = recordingOperations({
			title: "Inbox",
			finalUrl: "http://localhost/",
			console: [],
		});
		const tool = createBrowserTool({ operations: ops });

		const result = await tool.execute("call-1", { url: "http://localhost/" });

		expect(result.content.some((block) => block.type === "image")).toBe(false);
		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		expect(text).toMatch(/no screenshot/i);
	});
});
