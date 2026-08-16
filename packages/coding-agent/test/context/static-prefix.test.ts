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
	return Math.ceil(
		`${systemPrompt}
${JSON.stringify(tools)}`.length / 4,
	);
}

/**
 * Fixed by measurement once the full Phase 4 registry landed (task 4.7), not
 * speculative. Measured enforced prefix at that point: 2,150 tokens, against a naive
 * no-deferral projection of 2,706 -- every tool eligible for deferral by the phase's
 * own design decisions (read/bash/edit/write excluded because they're called on
 * nearly every task; plan_present excluded because it's called on nearly every
 * plan-mode turn; tool_schema can't defer itself) actually defers. The margin above
 * 2,150 absorbs incidental description-wording changes without making this a flaky
 * gate; it does not budge for a new tool that skips deferral without justification.
 */
const ENFORCED_PRODUCTION_PREFIX_BUDGET = 2_300;

describe("production static prefix (Phase 4 task 4.1/4.7)", () => {
	it("measures all registered production tools directly rather than the four-tool replay corpus", () => {
		const definitions = createAllToolDefinitions("/workspace");
		expect(Object.keys(definitions)).toContain("tool_schema");
		expect(productionPrefixTokens()).toBeGreaterThan(0);
	});

	it("stays under the enforced Phase 4 budget, fixed by the 4.7 measurement rather than assumed", () => {
		expect(productionPrefixTokens()).toBeLessThanOrEqual(ENFORCED_PRODUCTION_PREFIX_BUDGET);
	});

	it("the deferred-schema mechanism measurably absorbs cost: the enforced prefix is well under the naive no-deferral projection", () => {
		const definitions = createAllToolDefinitions("/workspace");
		const allNames = new Set(Object.keys(definitions));
		const enforced = productionPrefixTokens();
		const naiveNoDeferral = productionPrefixTokens({ loadedSchemaNames: allNames });
		expect(enforced).toBeLessThan(naiveNoDeferral);
		// Every tool this phase declared deferSchema: true for actually saves real
		// tokens once schemas stop being announced -- this is not a rounding error.
		expect(naiveNoDeferral - enforced).toBeGreaterThan(400);
	});
});
