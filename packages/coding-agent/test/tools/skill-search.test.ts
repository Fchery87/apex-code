import { describe, expect, it } from "vitest";
import {
	createSkillSearchToolDefinition,
	type SkillSearchEntry,
	type SkillSearchResolver,
	searchSkills,
} from "../../src/core/tools/skill-search.ts";

function resolverWith(skills: SkillSearchEntry[]): SkillSearchResolver {
	return { getSkills: () => skills };
}

const AGENT_BROWSER: SkillSearchEntry = { name: "agent-browser", description: "Browser automation CLI for AI agents." };
const CODE_REVIEW: SkillSearchEntry = { name: "code-review", description: "Review changes against coding standards." };
const DIAGNOSING_BUGS: SkillSearchEntry = { name: "diagnosing-bugs", description: "Diagnosis loop for hard bugs." };

describe("skill_search contract (SKILL.7)", () => {
	it("declares no capabilities, allow default, null ruleForCall, no evidence, and a deferred schema", () => {
		const definition = createSkillSearchToolDefinition(resolverWith([]));

		expect([...definition.contract.capabilities]).toEqual([]);
		expect(definition.contract.permission.defaultBehavior).toBe("allow");
		expect(definition.contract.permission.ruleForCall({})).toBeNull();
		expect(definition.contract.context.deferSchema).toBe(true);
		expect(definition.contract.context.resultRecoverable).toBe(true);
		expect([...definition.contract.evidence.emits]).toEqual([]);
		expect(definition.contract.evidence.capture({}, { content: [], details: {} })).toEqual([]);
	});

	it("never matches any rule content, since ruleForCall never generates one", () => {
		const definition = createSkillSearchToolDefinition(resolverWith([]));
		expect(definition.contract.permission.matches("**", { query: "anything" })).toBe(false);
	});
});

describe("searchSkills (SKILL.7)", () => {
	it("with no query, returns every skill name sorted, and no description", () => {
		const results = searchSkills(resolverWith([DIAGNOSING_BUGS, AGENT_BROWSER, CODE_REVIEW]), undefined);

		expect(results).toEqual([{ name: "agent-browser" }, { name: "code-review" }, { name: "diagnosing-bugs" }]);
	});

	it("with an empty or whitespace-only query, behaves the same as no query", () => {
		const skills = [AGENT_BROWSER];
		expect(searchSkills(resolverWith(skills), "")).toEqual([{ name: "agent-browser" }]);
		expect(searchSkills(resolverWith(skills), "   ")).toEqual([{ name: "agent-browser" }]);
	});

	it("with a query, returns matching names and their descriptions, case-insensitively", () => {
		const results = searchSkills(resolverWith([AGENT_BROWSER, CODE_REVIEW, DIAGNOSING_BUGS]), "BROWSER");

		expect(results).toEqual([{ name: "agent-browser", description: AGENT_BROWSER.description }]);
	});

	it("matches against the description as well as the name", () => {
		const results = searchSkills(resolverWith([AGENT_BROWSER, CODE_REVIEW, DIAGNOSING_BUGS]), "coding standards");

		expect(results).toEqual([{ name: "code-review", description: CODE_REVIEW.description }]);
	});

	it("returns an empty array for a query that matches nothing, rather than throwing", () => {
		expect(() => searchSkills(resolverWith([AGENT_BROWSER]), "no-such-skill")).not.toThrow();
		expect(searchSkills(resolverWith([AGENT_BROWSER]), "no-such-skill")).toEqual([]);
	});

	it("returns an empty array when no skills are loaded at all", () => {
		expect(searchSkills(resolverWith([]), undefined)).toEqual([]);
		expect(searchSkills(resolverWith([]), "anything")).toEqual([]);
	});

	it("sorts matching results alphabetically regardless of registry order", () => {
		// "e" appears in "agent-browser" (name) and "code-review" (name and
		// description), but neither the name nor description of "diagnosing-bugs"
		// contains it, so it's correctly excluded here.
		const results = searchSkills(resolverWith([DIAGNOSING_BUGS, CODE_REVIEW, AGENT_BROWSER]), "e");
		expect(results.map((r) => r.name)).toEqual(["agent-browser", "code-review"]);
	});
});

describe("skill_search execute (SKILL.7)", () => {
	it("returns the search results as both JSON content and details", async () => {
		const definition = createSkillSearchToolDefinition(resolverWith([AGENT_BROWSER]));

		const result = await definition.execute("call-1", { query: "browser" }, undefined, undefined, undefined as any);

		expect(result.details).toEqual({ results: [{ name: "agent-browser", description: AGENT_BROWSER.description }] });
		const text = result.content.find((c) => c.type === "text")?.text ?? "";
		expect(JSON.parse(text)).toEqual({
			results: [{ name: "agent-browser", description: AGENT_BROWSER.description }],
		});
	});
});
