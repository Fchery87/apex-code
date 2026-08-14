import { describe, expect, it } from "vitest";
import { projectToolSchemas } from "../../src/core/context/pipeline.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { createAllToolDefinitions } from "../../src/core/tools/index.ts";

function productionPrefixTokens(options?: { loadedSchemaNames?: ReadonlySet<string> }): number {
	const definitions = Object.values(createAllToolDefinitions("/workspace"));
	const tools = projectToolSchemas(
		definitions,
		(name) => definitions.find((definition) => definition.name === name)?.contract,
		options?.loadedSchemaNames,
	);
	const systemPrompt = buildSystemPrompt({
		cwd: "/workspace",
		customPrompt: "You are an expert coding assistant operating inside Apex Code.",
		selectedTools: definitions.map((definition) => definition.name),
		toolSnippets: Object.fromEntries(
			definitions.flatMap((definition) =>
				typeof definition.promptSnippet === "string" ? [[definition.name, definition.promptSnippet]] : [],
			),
		),
		promptGuidelines: definitions.flatMap((definition) => definition.promptGuidelines ?? []),
	});
	return Math.ceil(`${systemPrompt}
${JSON.stringify(tools)}`.length / 4);
}

describe("production static prefix (Phase 4 task 4.1)", () => {
	it("measures all registered production tools directly rather than the four-tool replay corpus", () => {
		const definitions = createAllToolDefinitions("/workspace");
		expect(Object.keys(definitions)).toContain("tool_schema");
		expect(productionPrefixTokens()).toBeGreaterThan(0);
	});

	it("records an announced-schema baseline before later tools opt into deferral", () => {
		const announced = productionPrefixTokens();
		const fullyLoaded = productionPrefixTokens({ loadedSchemaNames: new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]) });
		expect(announced).toBe(fullyLoaded);
	});
});
