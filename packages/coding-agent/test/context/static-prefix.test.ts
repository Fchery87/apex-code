import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectToolSchemas } from "../../src/core/context/pipeline.ts";
import { McpMetadataCache } from "../../src/core/mcp/metadata-cache.ts";
import { McpServerManager } from "../../src/core/mcp/server-manager.ts";
import { SKILL_CATALOG_PREFIX_BUDGET_TOKENS, type Skill } from "../../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { buildSystemPrompt } from "../../src/core/system-prompt.ts";
import { ALL_CAPABILITIES } from "../../src/core/tools/contract.ts";
import { createAllToolDefinitions, type ToolsOptions } from "../../src/core/tools/index.ts";

function productionPrefixTokens(options?: {
	loadedSchemaNames?: ReadonlySet<string>;
	toolOptions?: Parameters<typeof createAllToolDefinitions>[1];
	skills?: Skill[];
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
		skills: options?.skills,
	});
	return Math.ceil(
		`${systemPrompt}
${JSON.stringify(tools)}`.length / 4,
	);
}

/**
 * A skill name/description shape representative of a real installed library
 * (`docs/specs/2026-08-20-sandbox-skill-projection.md`'s measurement: a real
 * 115-skill library had 60 model-visible names with a 329-character median
 * description). The description length doesn't affect the production prefix --
 * SKILL.6's catalog carries names only -- but is included so this fixture would also
 * be realistic input to `formatSkillsForPrompt` directly, not just through the
 * production path this file measures.
 */
function syntheticSkill(index: number): Skill {
	const name = `synthetic-skill-name-number-${String(index).padStart(3, "0")}`;
	const filePath = `/home/user/.agents/skills/${name}/SKILL.md`;
	return {
		name,
		description: `A representative skill description of realistic length for skill number ${index}, covering a specific task the model might match against this text when deciding whether to search for it.`,
		filePath,
		baseDir: `/home/user/.agents/skills/${name}`,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "user" }),
		disableModelInvocation: false,
	};
}

/** More skills than any observed real library needs to stay bounded by SKILL_CATALOG_PREFIX_BUDGET_TOKENS regardless of size. */
const LARGE_SKILL_LIBRARY: Skill[] = Array.from({ length: 200 }, (_, i) => syntheticSkill(i));

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
 * to 2,500, a fresh ~5% anti-flake margin over the new measured floor.
 *
 * Re-measured at SKILL.8 (`docs/plans/2026-08-20-sandbox-skill-projection.md`):
 * `skill_search` (SKILL.7) is a new always-registered deferred tool, carrying the
 * no-skills floor from 2,372 to 2,393. Loading a skill library -- any size, per
 * `SKILL_CATALOG_PREFIX_BUDGET_TOKENS`'s whole point -- adds the bounded catalog
 * (SKILL.6) on top: measured at 2,987 with a 200-skill and separately a 2,000-skill
 * synthetic library (identical, confirming the bound holds regardless of library
 * size), 594 of those 600 possible tokens actually spent. Unlike every prior
 * revision of this budget, the worst case here is not "every tool active" but "every
 * tool active AND a skill library loaded", because a user's skill count is not the
 * product's to bound the same way tool count is. The budget is raised to 3,150, a
 * ~5.5% margin over the 2,987 measured worst case -- the same proportional margin
 * LSP.7 used, not a new policy. It does not budge for the next tool or the next
 * skill the same way this one didn't.
 *
 * Re-measured when a custom system prompt stopped discarding tool contributions:
 * `buildSystemPrompt`'s `customPrompt` branch returned before it read `toolSnippets`
 * or `promptGuidelines`, so this measurement -- which passes both, exactly as
 * `testing/replay/runner.ts` does -- was calibrated against a prefix the production
 * path never actually had the option of shipping. Restoring them carries the
 * skill-library floor from 2,987 to 3,261: 98 tokens of one-line tool snippets and
 * 177 of tool-contributed guidelines. Both the 200-skill and 2,000-skill libraries
 * measure 3,261, so the catalog bound still holds. The budget is raised to 3,450, a
 * ~5.5% margin over the new measured worst case, the same proportional margin
 * SKILL.8 and LSP.7 used. The guidelines are the half that matters: the tool JSON
 * schemas already carry names and descriptions, but nothing else carries
 * "prefer grep over bash" to the model.
 *
 * Re-measured for the `powershell` tool (upstream v0.84.3): a second always-available
 * exec tool alongside `bash` carries its own one-line snippet and its own entry in
 * the shell-choice guideline text ("Use bash or PowerShell for file operations...").
 * Both the 200-skill and 2,000-skill libraries measure 3,484, so the catalog bound
 * still holds. The budget is raised to 3,700, a ~5.5% margin over the new measured
 * worst case, the same proportional margin every prior revision of this budget used.
 * It does not budge for the next tool the same way this one didn't.
 */
const ENFORCED_PRODUCTION_PREFIX_BUDGET = 3_700;

function lspToolOptions() {
	return { lsp: { operations: { request: async () => [] } } };
}

/**
 * A configured MCP subsystem. Deliberately two servers with several cached tools
 * each: the whole point of the proxy is that the prefix does not grow with them.
 */
function mcpToolOptions(): ToolsOptions {
	const servers = new Map(
		["github", "files"].map((name) => [
			name,
			{
				name,
				transport: { kind: "stdio" as const, command: name, args: [], env: {}, cwd: undefined },
				capabilities: ALL_CAPABILITIES,
				lifecycle: "lazy" as const,
				idleTimeoutMinutes: 10,
			},
		]),
	);
	const cache = new McpMetadataCache(join(mkdtempSync(join(tmpdir(), "apex-mcp-prefix-")), "metadata.json"));
	for (const server of servers.values()) {
		cache.set(
			server,
			Array.from({ length: 20 }, (_, index) => ({
				server: server.name,
				name: `tool_${index}`,
				description: `Tool number ${index} on ${server.name}, with a description of realistic length.`,
				inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
			})),
		);
	}
	return {
		mcp: {
			servers,
			cache,
			manager: new McpServerManager({
				servers,
				connector: async () => {
					throw new Error("the static prefix must never connect");
				},
			}),
		},
	};
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

describe("production static prefix with mcp configured", () => {
	it("registers the mcp tool only when a server is configured", () => {
		expect(Object.keys(createAllToolDefinitions("/workspace"))).not.toContain("mcp");
		expect(Object.keys(createAllToolDefinitions("/workspace", mcpToolOptions()))).toContain("mcp");
	});

	it("leaves the prefix untouched when nothing is configured", () => {
		expect(productionPrefixTokens({ toolOptions: {} })).toBe(productionPrefixTokens());
	});

	it("stays under the enforced budget with two servers and forty cached tools", () => {
		expect(productionPrefixTokens({ toolOptions: mcpToolOptions() })).toBeLessThanOrEqual(
			ENFORCED_PRODUCTION_PREFIX_BUDGET,
		);
	});

	it("costs one announced tool, not one per server tool", () => {
		const delta = productionPrefixTokens({ toolOptions: mcpToolOptions() }) - productionPrefixTokens();
		// Forty tools registered directly would cost 150-300 tokens each. The proxy's
		// whole justification is that this number is a constant instead.
		// Measured at 185 tokens (2,891 -> 3,076) for two servers and forty cached tools.
		expect(delta).toBeGreaterThan(0);
		expect(delta).toBeLessThan(250);
	});
});

describe("production static prefix with skills loaded (SKILL.8)", () => {
	it("stays under the enforced budget with no skills loaded (the shipped default for most sessions)", () => {
		expect(productionPrefixTokens({ skills: [] })).toBeLessThanOrEqual(ENFORCED_PRODUCTION_PREFIX_BUDGET);
	});

	it("stays under the enforced budget with a large skill library loaded, because the catalog is bounded, not proportional to library size", () => {
		expect(productionPrefixTokens({ skills: LARGE_SKILL_LIBRARY })).toBeLessThanOrEqual(
			ENFORCED_PRODUCTION_PREFIX_BUDGET,
		);
	});

	it("the skill catalog's own contribution never exceeds SKILL_CATALOG_PREFIX_BUDGET_TOKENS, for any library size", () => {
		const withoutSkills = productionPrefixTokens({ skills: [] });
		const withSkills = productionPrefixTokens({ skills: LARGE_SKILL_LIBRARY });
		// A loose upper bound, not an exact difference: the catalog's own text is
		// bounded by SKILL_CATALOG_PREFIX_BUDGET_TOKENS, but the two prompts differ by
		// slightly more than that (the catalog's own header/footer overhead), and
		// separately the whole assembled prefix is re-tokenized with Math.ceil, which
		// can itself round up by a token independent of the catalog's real cost.
		expect(withSkills - withoutSkills).toBeLessThanOrEqual(SKILL_CATALOG_PREFIX_BUDGET_TOKENS + 5);
	});

	it("a library much larger than the catalog budget still produces a bounded, correctly-labeled prefix", () => {
		const hugeLibrary: Skill[] = Array.from({ length: 2000 }, (_, i) => syntheticSkill(i));
		const tokens = productionPrefixTokens({ skills: hugeLibrary });
		expect(tokens).toBeLessThanOrEqual(ENFORCED_PRODUCTION_PREFIX_BUDGET);
	});
});
