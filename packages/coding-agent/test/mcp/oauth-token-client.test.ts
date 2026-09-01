import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../../src/core/mcp/oauth/discover.ts";
import {
	exchangeAuthorizationCode,
	refreshAccessToken,
	TokenEndpointError,
} from "../../src/core/mcp/oauth/token-client.ts";

function jsonResponse(body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("exchangeAuthorizationCode", () => {
	it("posts the authorization-code grant with PKCE and resource, and parses the response", async () => {
		const fetch = vi.fn(async (_input: URL | string, init?: RequestInit): Promise<Response> => {
			expect(String(_input)).toBe("https://as.example/token");
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("grant_type")).toBe("authorization_code");
			expect(body.get("code")).toBe("the-code");
			expect(body.get("code_verifier")).toBe("the-verifier");
			expect(body.get("redirect_uri")).toBe("http://127.0.0.1:9/callback");
			expect(body.get("client_id")).toBe("client-1");
			expect(body.get("resource")).toBe("https://api.example/mcp");
			return jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
		}) as unknown as FetchLike;

		const token = await exchangeAuthorizationCode({
			tokenEndpoint: new URL("https://as.example/token"),
			code: "the-code",
			verifier: "the-verifier",
			redirectUri: "http://127.0.0.1:9/callback",
			clientId: "client-1",
			resource: "https://api.example/mcp",
			fetch,
		});
		expect(token).toEqual({ accessToken: "at", refreshToken: "rt", expiresInSeconds: 3600 });
	});

	it("maps a token-endpoint error response to a typed error carrying the OAuth error code", async () => {
		const fetch = vi.fn(
			async (): Promise<Response> => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
		) as unknown as FetchLike;
		const error = await exchangeAuthorizationCode({
			tokenEndpoint: new URL("https://as.example/token"),
			code: "c",
			verifier: "v",
			redirectUri: "http://127.0.0.1:9/callback",
			clientId: "client-1",
			fetch,
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TokenEndpointError);
		expect((error as TokenEndpointError).code).toBe("invalid_grant");
	});
});

describe("refreshAccessToken", () => {
	it("posts the refresh grant and tolerates a missing rotated refresh token", async () => {
		const fetch = vi.fn(async (_input: URL | string, init?: RequestInit): Promise<Response> => {
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("rt-old");
			return jsonResponse({ access_token: "at2", expires_in: 1800 });
		}) as unknown as FetchLike;

		const token = await refreshAccessToken({
			tokenEndpoint: new URL("https://as.example/token"),
			refreshToken: "rt-old",
			clientId: "client-1",
			fetch,
		});
		expect(token).toEqual({ accessToken: "at2", expiresInSeconds: 1800 });
	});
});
