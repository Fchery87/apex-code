import { describe, expect, it } from "vitest";
import { createDelegateToolDefinition, describeAgentCatalog } from "../../src/core/tools/delegate.ts";

const noRuntime = {} as never;

describe("agent catalog in the delegate description (HR.10)", () => {
	it("names each available agent type with its description", () => {
		const text = describeAgentCatalog([
			{ name: "explore", description: "Read-only search.", source: "built-in" },
			{ name: "general", description: "General helper.", source: "built-in" },
		]);
		expect(text).toContain("explore: Read-only search.");
		expect(text).toContain("general: General helper.");
	});

	it("stays bounded when many types exist", () => {
		const many = Array.from({ length: 80 }, (_, i) => ({
			name: `agent-${i}`,
			description: "x".repeat(200),
			source: "user" as const,
		}));
		const text = describeAgentCatalog(many);
		expect(text.length).toBeLessThanOrEqual(1500);
		expect(text).toMatch(/and \d+ more/);
	});

	it("appears in the delegate tool's description", () => {
		const definition = createDelegateToolDefinition(noRuntime, [
			{ name: "explore", description: "Read-only search.", source: "built-in" },
		]);
		expect(definition.description).toContain("explore: Read-only search.");
	});

	it("the delegate tool still describes itself with no catalog", () => {
		expect(createDelegateToolDefinition(noRuntime).description).toMatch(/^Delegate a task to a subagent/);
	});
});
