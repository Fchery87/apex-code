import type { AgentToolResult } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import type { ApexToolDefinition } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const skillSearchSchema = Type.Object({
	query: Type.Optional(
		Type.String({
			description:
				"Case-insensitive substring matched against skill names and descriptions. Omit to list every available skill name.",
		}),
	),
});

type SkillSearchInput = Static<typeof skillSearchSchema>;

export interface SkillSearchEntry {
	name: string;
	description: string;
}

export interface SkillSearchResolver {
	getSkills(): SkillSearchEntry[];
}

export interface SkillSearchResult {
	name: string;
	/** Present only when a query was given -- a name-only listing carries no description, matching the catalog's own name-only shape (ADR 0021). */
	description?: string;
}

/**
 * Resolve `skill_search`'s answer against the in-memory skill registry (ADR 0021,
 * SKILL.6's catalog is names only; this resolves the description behind a name).
 * Reads only from `resolver`; performs no filesystem or network I/O, which is why
 * the tool's contract holds no capabilities. An unmatched query returns an empty
 * array rather than throwing -- there is no such thing as an invalid search.
 */
export function searchSkills(resolver: SkillSearchResolver, query: string | undefined): SkillSearchResult[] {
	const skills = resolver.getSkills();
	const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));

	if (query === undefined || query.trim() === "") {
		return sorted.map((skill) => ({ name: skill.name }));
	}

	const needle = query.trim().toLowerCase();
	return sorted
		.filter((skill) => skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle))
		.map((skill) => ({ name: skill.name, description: skill.description }));
}

/** Create the model-callable skill discovery tool settled by ADR 0021. */
export function createSkillSearchToolDefinition(
	resolver: SkillSearchResolver,
): ApexToolDefinition<typeof skillSearchSchema> {
	return {
		name: "skill_search",
		label: "skill_search",
		description:
			"List available skill names, or search their names and descriptions by a query. Use to find a skill named in the prompt before reading its file.",
		parameters: skillSearchSchema,
		contract: {
			capabilities: new Set(),
			permission: {
				defaultBehavior: "allow",
				matches: () => false,
				describe: () => "Searching the skill catalog",
				ruleForCall: () => null,
			},
			context: { resultRecoverable: true, deferSchema: true },
			evidence: { emits: new Set(), capture: () => [] },
		},
		async execute(_toolCallId, { query }: SkillSearchInput): Promise<AgentToolResult<unknown>> {
			const results = searchSkills(resolver, query);
			return {
				content: [{ type: "text", text: JSON.stringify({ results }) }],
				details: { results },
			};
		},
	};
}

export function createSkillSearchTool(resolver: SkillSearchResolver) {
	return wrapToolDefinition(createSkillSearchToolDefinition(resolver));
}
