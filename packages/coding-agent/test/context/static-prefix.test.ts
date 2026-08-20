import { describe, expect, it } from "vitest";
import { projectToolSchemas } from "../../src/core/context/pipeline.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { createAllToolDefinitions } from "../../src/core/tools/index.ts";

function productionPrefixTokens(options?: {
	loadedSchemaNames?: ReadonlySet<string>;
	toolOptions?: Parameters<typeof createAllToolDefinitions>[1];
}): number {
	const definitions = Object.values(createAllToolDefinitions("/workspace", options?.toolOptions));
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
 *
 * Re-measured at LSP.7 (`docs/plans/2026-08-18-lsp.md`): unrelated tool-description
 * drift across phases 5-8 had already carried the no-`lsp` baseline from 2,150 to
 * 2,292, silently spending the entire original margin before `lsp` (this plan's own
 * new deferred tool) added anything. With `lsp` registered and its description
 * trimmed to the bone, the measured prefix is 2,372. Per this file's own precedent --
 * fix the ceiling from a real measurement, don't assume one -- the budget is raised
 * to 2,500, a fresh ~5% anti-flake margin over the new measured floor. It does not
 * budge for the next tool the same way this one didn't.
 */
const ENFORCED_PRODUCTION_PREFIX_BUDGET = 2_500;

function lspToolOptions() {
	return { lsp: { operations: { request: async () => [] } } };
}

describe("production static prefix (Phase 4 task 4.1/4.7)", () => {
	it("measures all registered production tools directly rather than the four-tool replay corpus", () => {
		const definitions = createAllToolDefinitions("/workspace");
		expect(Object.keys(definitions)).toContain("tool_schema");
		expect(productionPrefixTokens()).toBeGreaterThan(0);
	});

	it("stays under the enforced budget with no lsp server configured", () => {
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

describe("production static prefix with lsp configured (LSP.7)", () => {
	it("stays under the enforced budget with an lsp server configured and deferred", () => {
		const definitions = createAllToolDefinitions("/workspace", lspToolOptions());
		expect(Object.keys(definitions)).toContain("lsp");
		expect(productionPrefixTokens({ toolOptions: lspToolOptions() })).toBeLessThanOrEqual(
			ENFORCED_PRODUCTION_PREFIX_BUDGET,
		);
	});
});
