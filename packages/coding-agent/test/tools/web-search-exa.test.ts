import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createExaWebSearchOperations } from "../../src/core/tools/web-search-exa.ts";

interface CapturedRequest {
	method: string;
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

interface StubEndpoint {
	url: string;
	requests: CapturedRequest[];
	close(): Promise<void>;
}

/**
 * A real HTTP server rather than an injected `fetch`: the adapter reaches the
 * network through `globalThis.fetch` exactly like `web_fetch` does, so that is the
 * path worth exercising. Injecting a fake would test a seam production never uses.
 */
async function startStubEndpoint(
	handler: (request: CapturedRequest) => { status: number; body: unknown },
): Promise<StubEndpoint> {
	const requests: CapturedRequest[] = [];
	const server: Server = createServer((incoming, outgoing) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk) => chunks.push(chunk as Buffer));
		incoming.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const captured: CapturedRequest = {
				method: incoming.method ?? "",
				path: incoming.url ?? "",
				headers: incoming.headers,
				body: raw ? JSON.parse(raw) : undefined,
			};
			requests.push(captured);
			const { status, body } = handler(captured);
			outgoing.writeHead(status, { "content-type": "application/json" });
			outgoing.end(JSON.stringify(body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/search`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

let endpoint: StubEndpoint | undefined;

afterEach(async () => {
	await endpoint?.close();
	endpoint = undefined;
});

describe("Exa web search request shape", () => {
	it("POSTs the query with the API key in the x-api-key header", async () => {
		endpoint = await startStubEndpoint(() => ({ status: 200, body: { requestId: "r1", results: [] } }));
		const operations = createExaWebSearchOperations({ apiKey: "exa-test-key", endpoint: endpoint.url });

		await operations.search("typescript generics");

		expect(endpoint.requests).toHaveLength(1);
		const request = endpoint.requests[0];
		expect(request?.method).toBe("POST");
		expect(request?.headers["x-api-key"]).toBe("exa-test-key");
		expect(request?.headers["content-type"]).toBe("application/json");
		expect(request?.body).toMatchObject({ query: "typescript generics" });
	});

	it("requests text contents so every result can carry a snippet", async () => {
		endpoint = await startStubEndpoint(() => ({ status: 200, body: { requestId: "r1", results: [] } }));
		const operations = createExaWebSearchOperations({
			apiKey: "exa-test-key",
			endpoint: endpoint.url,
			numResults: 3,
			snippetMaxCharacters: 250,
		});

		await operations.search("anything");

		expect(endpoint.requests[0]?.body).toMatchObject({
			numResults: 3,
			contents: {
				// Highlights are query-relevant excerpts; text is the fallback when a page
				// yields none.
				highlights: { query: "anything", maxCharacters: 250 },
				text: { maxCharacters: 250 },
			},
		});
	});
});

describe("Exa web search response mapping", () => {
	it("maps Exa results onto title, url, and snippet", async () => {
		endpoint = await startStubEndpoint(() => ({
			status: 200,
			body: {
				requestId: "r1",
				results: [
					{
						id: "https://example.com/a",
						title: "Alpha",
						url: "https://example.com/a",
						text: "Alpha body text.",
						publishedDate: "2026-01-01T00:00:00.000Z",
					},
				],
			},
		}));
		const operations = createExaWebSearchOperations({ apiKey: "k", endpoint: endpoint.url });

		const results = await operations.search("alpha");

		expect(results).toEqual([{ title: "Alpha", url: "https://example.com/a", snippet: "Alpha body text." }]);
	});

	it("collapses snippet whitespace and truncates to the configured budget", async () => {
		endpoint = await startStubEndpoint(() => ({
			status: 200,
			body: {
				results: [{ title: "Long", url: "https://example.com/long", text: `a\n\n  b${"c".repeat(400)}` }],
			},
		}));
		const operations = createExaWebSearchOperations({
			apiKey: "k",
			endpoint: endpoint.url,
			snippetMaxCharacters: 20,
		});

		const [result] = await operations.search("long");

		expect(result?.snippet.length).toBeLessThanOrEqual(20);
		expect(result?.snippet).not.toContain("\n");
	});

	it("falls back to the URL when Exa returns no title, and to an empty snippet when it returns no text", async () => {
		endpoint = await startStubEndpoint(() => ({
			status: 200,
			body: { results: [{ url: "https://example.com/untitled" }] },
		}));
		const operations = createExaWebSearchOperations({ apiKey: "k", endpoint: endpoint.url });

		const results = await operations.search("untitled");

		expect(results).toEqual([
			{ title: "https://example.com/untitled", url: "https://example.com/untitled", snippet: "" },
		]);
	});

	it("drops results with no usable URL rather than emitting a broken citation", async () => {
		endpoint = await startStubEndpoint(() => ({
			status: 200,
			body: { results: [{ title: "No URL" }, { title: "Fine", url: "https://example.com/fine" }] },
		}));
		const operations = createExaWebSearchOperations({ apiKey: "k", endpoint: endpoint.url });

		const results = await operations.search("mixed");

		expect(results.map((result) => result.url)).toEqual(["https://example.com/fine"]);
	});

	it("returns an empty array when Exa reports no results", async () => {
		endpoint = await startStubEndpoint(() => ({ status: 200, body: { requestId: "r1", results: [] } }));
		const operations = createExaWebSearchOperations({ apiKey: "k", endpoint: endpoint.url });

		await expect(operations.search("nothing")).resolves.toEqual([]);
	});
});

describe("Exa web search failures", () => {
	it("throws a model-readable error naming the status, without echoing the API key", async () => {
		endpoint = await startStubEndpoint(() => ({ status: 401, body: { error: "invalid api key" } }));
		const operations = createExaWebSearchOperations({ apiKey: "super-secret-key", endpoint: endpoint.url });

		await expect(operations.search("denied")).rejects.toThrow(/401/);
		await expect(operations.search("denied")).rejects.not.toThrow(/super-secret-key/);
	});

	it("names the rejected host so a sandbox allowlist gap is actionable", async () => {
		const operations = createExaWebSearchOperations({
			apiKey: "k",
			endpoint: "http://127.0.0.1:1/search",
		});

		await expect(operations.search("unreachable")).rejects.toThrow(/127\.0\.0\.1/);
	});

	it("refuses to construct without an API key rather than sending an unauthenticated request", () => {
		expect(() => createExaWebSearchOperations({ apiKey: "  " })).toThrow(/api key/i);
	});
});

describe("Exa web search snippet source", () => {
	it("prefers query-relevant highlights over the top of the page", async () => {
		endpoint = await startStubEndpoint(() => ({
			status: 200,
			body: {
				results: [
					{
						title: "Doc",
						url: "https://example.com/doc",
						// What `contents.text` returns: navigation chrome first.
						text: "Skip to content Subscribe to RSS Back to all posts. The actual answer is here.",
						highlights: ["The actual answer is here."],
					},
				],
			},
		}));
		const operations = createExaWebSearchOperations({ apiKey: "k", endpoint: endpoint.url });

		const [result] = await operations.search("what is the answer");

		expect(result?.snippet).toBe("The actual answer is here.");
		expect(result?.snippet).not.toContain("Skip to content");
	});

	it("truncates at a word boundary instead of ending mid-word", async () => {
		endpoint = await startStubEndpoint(() => ({
			status: 200,
			body: {
				results: [
					{
						title: "MCP",
						url: "https://example.com/mcp",
						// 48 characters; a 30-character budget would cut inside "specificatio".
						text: "The next generation specification release",
						highlights: ["The next generation specification release"],
					},
				],
			},
		}));
		const operations = createExaWebSearchOperations({
			apiKey: "k",
			endpoint: endpoint.url,
			snippetMaxCharacters: 30,
		});

		const [result] = await operations.search("q");

		// "The next generation specification" is 33 characters; the boundary trim gives
		// back the whole words that fit rather than "The next generation specificatio".
		expect(result?.snippet).toBe("The next generation");
	});

	it("joins multiple highlights so the gaps between passages are visible", async () => {
		endpoint = await startStubEndpoint(() => ({
			status: 200,
			body: {
				results: [{ title: "T", url: "https://example.com/t", highlights: ["First passage.", "Second passage."] }],
			},
		}));
		const operations = createExaWebSearchOperations({ apiKey: "k", endpoint: endpoint.url });

		const [result] = await operations.search("q");

		expect(result?.snippet).toBe("First passage. … Second passage.");
	});

	it("falls back to page text when a result yields no highlights", async () => {
		endpoint = await startStubEndpoint(() => ({
			status: 200,
			body: { results: [{ title: "T", url: "https://example.com/t", text: "Body text.", highlights: [] }] },
		}));
		const operations = createExaWebSearchOperations({ apiKey: "k", endpoint: endpoint.url });

		const [result] = await operations.search("q");

		expect(result?.snippet).toBe("Body text.");
	});

	it("still truncates and collapses whitespace in a highlight", async () => {
		endpoint = await startStubEndpoint(() => ({
			status: 200,
			body: { results: [{ title: "T", url: "https://example.com/t", highlights: [`a\n\n  b${"c".repeat(400)}`] }] },
		}));
		const operations = createExaWebSearchOperations({
			apiKey: "k",
			endpoint: endpoint.url,
			snippetMaxCharacters: 20,
		});

		const [result] = await operations.search("q");

		expect(result?.snippet.length).toBeLessThanOrEqual(20);
		expect(result?.snippet).not.toContain("\n");
	});
});
