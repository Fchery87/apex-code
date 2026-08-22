import type { WebSearchOperations, WebSearchResult } from "./web-search.ts";

/** Exa's hosted search endpoint. */
export const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";

/** Host of {@link EXA_SEARCH_ENDPOINT}, for the sandbox network allowlist. */
export const EXA_SEARCH_HOST = "api.exa.ai";

/** Exa's own default is 10; matching it keeps an unconfigured session predictable. */
export const DEFAULT_EXA_RESULT_COUNT = 10;

/**
 * Snippet budget per result. Exa returns whole page text when asked, which is the
 * wrong unit for a search result -- ten full pages would dwarf every other tool
 * result in the context window. 800 characters is roughly a paragraph, enough for
 * the model to judge relevance and decide whether to spend a `web_fetch` on it.
 */
export const DEFAULT_EXA_SNIPPET_CHARACTERS = 800;

export interface ExaWebSearchOptions {
	/** Resolved key, never a `$VAR` reference -- resolution happens before this call. */
	apiKey: string;
	/** Override for an Exa-compatible endpoint. Defaults to {@link EXA_SEARCH_ENDPOINT}. */
	endpoint?: string;
	numResults?: number;
	snippetMaxCharacters?: number;
}

/** The subset of Exa's `/search` response this adapter reads. */
interface ExaSearchResult {
	title?: string | null;
	url?: string | null;
	text?: string | null;
}

interface ExaSearchResponse {
	results?: ExaSearchResult[] | null;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return endpoint;
	}
}

/**
 * Page text arrives with the source document's line structure intact. Collapsing it
 * to a single line costs nothing in meaning and keeps a ten-result list readable as
 * a list rather than ten wrapped blocks.
 */
function toSnippet(text: string | null | undefined, maxCharacters: number): string {
	if (!text) return "";
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > maxCharacters ? collapsed.slice(0, maxCharacters) : collapsed;
}

function toWebSearchResults(payload: ExaSearchResponse, maxCharacters: number): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	for (const result of payload.results ?? []) {
		const url = result?.url?.trim();
		// A result the model cannot cite or fetch is worse than one fewer result.
		if (!url) continue;
		results.push({ title: result.title?.trim() || url, url, snippet: toSnippet(result.text, maxCharacters) });
	}
	return results;
}

/**
 * Exa-backed `web_search` backend.
 *
 * Reaches the network through `globalThis.fetch` for the same reason `web_fetch`
 * does: that is the dispatcher `configureHttpDispatcher` made proxy-aware, so an
 * allowlisted host routes through the sandbox proxy and a disallowed one has no
 * route at all. Opening a raw socket here would sidestep a boundary this tool is
 * supposed to sit behind.
 */
export function createExaWebSearchOperations(options: ExaWebSearchOptions): WebSearchOperations {
	const apiKey = options.apiKey?.trim();
	if (!apiKey) {
		throw new Error("Exa web search requires an API key; none was resolved.");
	}
	const endpoint = options.endpoint ?? EXA_SEARCH_ENDPOINT;
	const host = hostOf(endpoint);
	const numResults = options.numResults ?? DEFAULT_EXA_RESULT_COUNT;
	const snippetMaxCharacters = options.snippetMaxCharacters ?? DEFAULT_EXA_SNIPPET_CHARACTERS;

	return {
		async search(query, signal) {
			let response: Response;
			try {
				response = await fetch(endpoint, {
					method: "POST",
					headers: { "content-type": "application/json", "x-api-key": apiKey },
					body: JSON.stringify({
						query,
						numResults,
						contents: { text: { maxCharacters: snippetMaxCharacters } },
					}),
					signal,
				});
			} catch (error) {
				if (isAbortError(error)) throw error;
				// `fetch failed` alone names neither the host nor the remedy. The sandbox
				// refusal wrapper's message, when it produced one, is preserved verbatim here.
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(`web_search request to ${host} failed: ${detail}`, { cause: error });
			}

			if (!response.ok) {
				// The body can echo request fields, so only the status is reported -- a
				// pasted-through body is how an API key ends up in a transcript.
				throw new Error(`web_search request to ${host} failed with HTTP ${response.status}.`);
			}

			const payload = (await response.json()) as ExaSearchResponse;
			return toWebSearchResults(payload, snippetMaxCharacters);
		},
	};
}
