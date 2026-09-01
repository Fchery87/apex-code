import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { FetchLike } from "../../src/core/mcp/oauth/discover.ts";
import {
	ensureFreshServerToken,
	McpOAuthRefreshError,
	McpOAuthRequiredError,
	readServerToken,
} from "../../src/core/mcp/oauth/mcp-token.ts";
import type { McpServerConfig } from "../../src/core/mcp/types.ts";
import { ALL_CAPABILITIES } from "../../src/core/tools/contract.ts";

function httpServer(name: string, url: string): McpServerConfig {
	return {
		name,
		transport: { kind: "http", url, headers: {}, bearerTokenEnv: undefined },
		auth: "oauth",
		capabilities: ALL_CAPABILITIES,
		lifecycle: "lazy",
		idleTimeoutMinutes: 10,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function storeWith(entry: Record<string, unknown>): AuthStorage {
	return AuthStorage.inMemory({ "mcp/srv": entry as never });
}

const SERVER = httpServer("srv", "https://api.example/mcp");

describe("readServerToken", () => {
	it("returns undefined when nothing is stored", async () => {
		expect(await readServerToken(AuthStorage.inMemory(), "srv")).toBeUndefined();
	});

	it("reads the token and the extras the flow records", async () => {
		const stored = await readServerToken(
			storeWith({
				type: "oauth",
				access: "at",
				refresh: "rt",
				expires: 123,
				tokenEndpoint: "https://as/t",
				resource: "https://api/mcp",
				clientId: "c1",
			}),
			"srv",
		);
		expect(stored).toEqual({
			accessToken: "at",
			refreshToken: "rt",
			expiresAt: 123,
			extras: { tokenEndpoint: "https://as/t", resource: "https://api/mcp", clientId: "c1" },
		});
	});
});

describe("ensureFreshServerToken", () => {
	it("returns a current access token without contacting anything", async () => {
		const credentials = storeWith({ type: "oauth", access: "at", refresh: "rt", expires: Date.now() + 600_000 });
		const fetch = vi.fn() as unknown as FetchLike;
		expect(await ensureFreshServerToken({ server: SERVER, credentials, fetch })).toBe("at");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("throws the required error naming the auth command when nothing is stored", async () => {
		const error = await ensureFreshServerToken({ server: SERVER, credentials: AuthStorage.inMemory() }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(McpOAuthRequiredError);
		expect((error as Error).message).toContain("apex-code mcp auth srv");
	});

	it("refreshes an expired token via the stored endpoint and persists the rotation", async () => {
		const credentials = storeWith({
			type: "oauth",
			access: "old",
			refresh: "rt-old",
			expires: Date.now() - 1_000,
			tokenEndpoint: "https://as.example/token",
			resource: "https://api.example/mcp",
			clientId: "client-1",
		});
		const fetch = vi.fn(async (input: URL | string, init?: RequestInit): Promise<Response> => {
			expect(String(input)).toBe("https://as.example/token");
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("rt-old");
			expect(body.get("client_id")).toBe("client-1");
			expect(body.get("resource")).toBe("https://api.example/mcp");
			return jsonResponse({ access_token: "new", refresh_token: "rt-new", expires_in: 3600 });
		}) as unknown as FetchLike;

		expect(await ensureFreshServerToken({ server: SERVER, credentials, fetch })).toBe("new");
		const rotated = await credentials.read("mcp/srv");
		expect(rotated?.type === "oauth" && rotated.access).toBe("new");
		expect(rotated?.type === "oauth" && rotated.refresh).toBe("rt-new");
	});

	it("keeps the old refresh token when the server does not rotate", async () => {
		const credentials = storeWith({
			type: "oauth",
			access: "old",
			refresh: "keep",
			expires: Date.now() - 1_000,
			tokenEndpoint: "https://as.example/token",
		});
		const fetch = vi.fn(
			async (): Promise<Response> => jsonResponse({ access_token: "new", expires_in: 60 }),
		) as unknown as FetchLike;
		await ensureFreshServerToken({ server: SERVER, credentials, fetch });
		const rotated = await credentials.read("mcp/srv");
		expect(rotated?.type === "oauth" && rotated.refresh).toBe("keep");
	});

	it("discovers the token endpoint when none was recorded", async () => {
		const credentials = storeWith({ type: "oauth", access: "old", refresh: "rt", expires: Date.now() - 1_000 });
		const fetch = vi.fn(async (input: URL | string): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("oauth-protected-resource")) return Promise.resolve(new Response("no", { status: 404 }));
			if (url === "https://api.example/.well-known/oauth-authorization-server") {
				return Promise.resolve(
					jsonResponse({
						authorization_endpoint: "https://api.example/a",
						token_endpoint: "https://api.example/token",
					}),
				);
			}
			if (url === "https://api.example/token") {
				return jsonResponse({ access_token: "new", expires_in: 3600 });
			}
			throw new Error(`unexpected fetch ${url}`);
		}) as unknown as FetchLike;

		expect(await ensureFreshServerToken({ server: SERVER, credentials, fetch })).toBe("new");
	});

	it("classifies invalid_grant as refused", async () => {
		const credentials = storeWith({
			type: "oauth",
			access: "old",
			refresh: "rt",
			expires: Date.now() - 1_000,
			tokenEndpoint: "https://as.example/token",
		});
		const fetch = vi.fn(
			async (): Promise<Response> => jsonResponse({ error: "invalid_grant" }, 400),
		) as unknown as FetchLike;
		const error = await ensureFreshServerToken({ server: SERVER, credentials, fetch }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(McpOAuthRefreshError);
		expect((error as McpOAuthRefreshError).stage).toBe("refused");
		expect((error as Error).message).toContain("apex-code mcp auth srv");
	});

	it("classifies a network failure as unavailable", async () => {
		const credentials = storeWith({
			type: "oauth",
			access: "old",
			refresh: "rt",
			expires: Date.now() - 1_000,
			tokenEndpoint: "https://as.example/token",
		});
		const fetch = vi.fn(async (): Promise<Response> => {
			throw new Error("socket hangup");
		}) as unknown as FetchLike;
		const error = await ensureFreshServerToken({ server: SERVER, credentials, fetch }).catch(
			(caught: unknown) => caught,
		);
		expect((error as McpOAuthRefreshError).stage).toBe("unavailable");
	});

	it("fails closed when the store refuses the rotation write", async () => {
		const credentials = storeWith({
			type: "oauth",
			access: "old",
			refresh: "rt",
			expires: Date.now() - 1_000,
			tokenEndpoint: "https://as.example/token",
		});
		credentials.modify = async (): Promise<undefined> => {
			throw new Error("read-only credential storage cannot modify auth.json");
		};
		const fetch = vi.fn(
			async (): Promise<Response> => jsonResponse({ access_token: "new", expires_in: 3600 }),
		) as unknown as FetchLike;
		const error = await ensureFreshServerToken({ server: SERVER, credentials, fetch }).catch(
			(caught: unknown) => caught,
		);
		expect((error as McpOAuthRefreshError).stage).toBe("unavailable");
		expect((error as Error).message).toContain("cannot store the new token");
	});

	it("refuses to refresh when the server issued no refresh token", async () => {
		const credentials = storeWith({ type: "oauth", access: "old", refresh: "", expires: Date.now() - 1_000 });
		const error = await ensureFreshServerToken({ server: SERVER, credentials }).catch((caught: unknown) => caught);
		expect((error as McpOAuthRefreshError).stage).toBe("refused");
		expect((error as Error).message).toContain("no refresh token");
	});
});
