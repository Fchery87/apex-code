import { describe, expect, it, vi } from "vitest";
import {
	discoverAuthorizationServer,
	type FetchLike,
	OAuthDiscoveryError,
	parseWwwAuthenticate,
} from "../../src/core/mcp/oauth/discover.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetch_ok = vi.fn(async (): Promise<Response> => jsonResponse({ ignored: true })) as unknown as FetchLike;

describe("parseWwwAuthenticate", () => {
	it("extracts resource_metadata from a Bearer challenge", () => {
		expect(
			parseWwwAuthenticate(
				'Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource"',
			),
		).toEqual({
			resourceMetadata: "https://a.example/.well-known/oauth-protected-resource",
		});
	});

	it("is case-insensitive on the scheme and parameter", () => {
		expect(parseWwwAuthenticate('bearer RESOURCE_METADATA="https://a.example/prm"')).toEqual({
			resourceMetadata: "https://a.example/prm",
		});
	});

	it("returns empty for absent headers and non-Bearer challenges", () => {
		expect(parseWwwAuthenticate(undefined)).toEqual({});
		expect(parseWwwAuthenticate('Basic realm="x"')).toEqual({});
		expect(parseWwwAuthenticate("Bearer")).toEqual({});
	});
});

describe("discoverAuthorizationServer", () => {
	it("walks www-authenticate → PRM → authorization server metadata", async () => {
		const fetch = vi.fn((input: URL | string): Promise<Response> => {
			const url = String(input);
			if (url === "https://api.example/prm") {
				return Promise.resolve(
					jsonResponse({ resource: "https://api.example", authorization_servers: ["https://as.example"] }),
				);
			}
			if (url === "https://as.example/.well-known/oauth-authorization-server") {
				return Promise.resolve(
					jsonResponse({
						authorization_endpoint: "https://as.example/authorize",
						token_endpoint: "https://as.example/token",
					}),
				);
			}
			return Promise.reject(new Error(`unexpected fetch ${url}`));
		}) as unknown as FetchLike;

		const metadata = await discoverAuthorizationServer({
			serverUrl: "https://api.example/mcp",
			wwwAuthenticate: 'Bearer resource_metadata="https://api.example/prm"',
			fetch,
		});
		expect(metadata).toEqual({
			authorizationEndpoint: "https://as.example/authorize",
			tokenEndpoint: "https://as.example/token",
			registrationEndpoint: undefined,
		});
	});

	it("falls back to path-aware well-known URIs without a challenge", async () => {
		const fetch = vi.fn((input: URL | string): Promise<Response> => {
			const url = String(input);
			if (url === "https://api.example/.well-known/oauth-protected-resource/mcp") {
				return Promise.resolve(jsonResponse({ resource: "r", authorization_servers: ["https://as.example"] }));
			}
			if (url === "https://as.example/.well-known/oauth-authorization-server") {
				return Promise.resolve(
					jsonResponse({
						authorization_endpoint: "https://as.example/authorize",
						token_endpoint: "https://as.example/token",
						registration_endpoint: "https://as.example/register",
					}),
				);
			}
			return Promise.reject(new Error(`unexpected fetch ${url}`));
		}) as unknown as FetchLike;

		const metadata = await discoverAuthorizationServer({ serverUrl: "https://api.example/mcp", fetch });
		expect(metadata.registrationEndpoint).toBe("https://as.example/register");
	});

	it("falls back to the authorization-server well-known on the server origin when no PRM exists", async () => {
		const fetch = vi.fn((input: URL | string): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("oauth-protected-resource")) return Promise.resolve(new Response("no", { status: 404 }));
			if (url === "https://api.example/.well-known/oauth-authorization-server") {
				return Promise.resolve(
					jsonResponse({
						authorization_endpoint: "https://api.example/authorize",
						token_endpoint: "https://api.example/token",
					}),
				);
			}
			return Promise.reject(new Error(`unexpected fetch ${url}`));
		}) as unknown as FetchLike;

		const metadata = await discoverAuthorizationServer({ serverUrl: "https://api.example/mcp", fetch });
		expect(metadata.tokenEndpoint).toBe("https://api.example/token");
	});

	it("refuses non-https metadata URLs on non-loopback servers", async () => {
		await expect(
			discoverAuthorizationServer({
				serverUrl: "http://api.example/mcp",
				wwwAuthenticate: 'Bearer resource_metadata="http://api.example/prm"',
				fetch: fetch_ok,
			}),
		).rejects.toBeInstanceOf(OAuthDiscoveryError);
	});

	it("allows loopback http so local servers are testable", async () => {
		const fetch = vi.fn(async (input: URL | string): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/.well-known/oauth-authorization-server")) {
				return Promise.resolve(
					jsonResponse({ authorization_endpoint: "http://127.0.0.1/a", token_endpoint: "http://127.0.0.1/t" }),
				);
			}
			return Promise.resolve(new Response("no", { status: 404 }));
		}) as unknown as FetchLike;

		const metadata = await discoverAuthorizationServer({ serverUrl: "http://127.0.0.1:9988/mcp", fetch });
		expect(metadata.authorizationEndpoint).toBe("http://127.0.0.1/a");
	});

	it("fails with a named error when metadata lacks the required endpoints", async () => {
		const fetch = vi.fn(async (): Promise<Response> => jsonResponse({ resource: "r" })) as unknown as FetchLike;
		await expect(discoverAuthorizationServer({ serverUrl: "https://api.example/mcp", fetch })).rejects.toBeInstanceOf(
			OAuthDiscoveryError,
		);
	});
});
