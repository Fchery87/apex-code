import { Type, type Static } from "typebox";
import type { AgentToolResult } from "apex-code-agent-core";
import type { ApexToolDefinition } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const webSearchSchema = Type.Object({
	query: Type.String({ description: "The search query." }),
});

export type WebSearchInput = Static<typeof webSearchSchema>;

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface WebSearchDetails {
	results: WebSearchResult[];
}

export interface WebSearchOperations {
	search(query: string, signal?: AbortSignal): Promise<WebSearchResult[]>;
}

/**
 * No search vendor is wired into this repo (unlike web_fetch, which needs only an
 * HTTP GET). A deployment supplies its own provider via `WebSearchToolOptions`;
 * failing loudly here beats a silent no-op that would look like zero results.
 */
const unconfiguredWebSearchOperations: WebSearchOperations = {
	async search() {
		throw new Error(
			"web_search is not configured: no search provider was supplied. Pass WebSearchToolOptions.operations.",
		);
	},
};

function formatResults(results: WebSearchResult[]): string {
	if (results.length === 0) return "No results found.";
	return results.map((result) => `${result.title}\n${result.url}\n${result.snippet}`).join("\n\n");
}

export interface WebSearchToolOptions {
	operations?: WebSearchOperations;
}

export function createWebSearchToolDefinition(
	options?: WebSearchToolOptions,
): ApexToolDefinition<typeof webSearchSchema, WebSearchDetails> {
	const ops = options?.operations ?? unconfiguredWebSearchOperations;
	return {
		name: "web_search",
		label: "web_search",
		description: "Search the web and return a list of results.",
		parameters: webSearchSchema,
		contract: {
			capabilities: new Set(["net"]),
			permission: {
				defaultBehavior: "ask",
				// A query is not a generalizable rule (ruleForCall returns null); the only
				// rule content worth recognizing is a hand-authored blanket "*".
				matches: (ruleContent) => ruleContent === "*",
				describe: () => "Web search (any query)",
				ruleForCall: () => null,
			},
			context: { resultRecoverable: false, deferSchema: true },
			evidence: { emits: new Set(), capture: () => [] },
		},
		async execute(
			_toolCallId,
			{ query }: WebSearchInput,
			signal?: AbortSignal,
		): Promise<AgentToolResult<WebSearchDetails>> {
			const results = await ops.search(query, signal);
			return {
				content: [{ type: "text", text: formatResults(results) }],
				details: { results },
			};
		},
	};
}

export function createWebSearchTool(options?: WebSearchToolOptions) {
	return wrapToolDefinition(createWebSearchToolDefinition(options));
}
