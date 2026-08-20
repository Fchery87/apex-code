import { describe, expect, it } from "vitest";
import { createAllToolDefinitions, createAllTools } from "../../src/core/tools/index.ts";

describe("conditional lsp registry", () => {
	it("does not register lsp without configured operations", () => {
		expect(Object.keys(createAllToolDefinitions("/workspace"))).not.toContain("lsp");
		expect(Object.keys(createAllTools("/workspace"))).not.toContain("lsp");
	});

	it("registers exactly one deferred lsp tool when configured", () => {
		const options = { lsp: { operations: { request: async () => [] } } };
		const definitions = createAllToolDefinitions("/workspace", options);
		const tools = createAllTools("/workspace", options);
		expect(Object.keys(definitions).filter((name) => name === "lsp")).toEqual(["lsp"]);
		expect(Object.keys(tools).filter((name) => name === "lsp")).toEqual(["lsp"]);
		expect(definitions.lsp?.contract.context.deferSchema).toBe(true);
	});
});
