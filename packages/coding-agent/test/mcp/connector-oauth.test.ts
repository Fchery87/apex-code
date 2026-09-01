import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createSessionMcpConnector, resolveAuthorizationHeaders } from "../../src/core/mcp/connector.ts";
import { McpOAuthRequiredError } from "../../src/core/mcp/oauth/mcp-token.ts";
import type { McpServerConfig } from "../../src/core/mcp/types.ts";
import { ALL_CAPABILITIES } from "../../src/core/tools/contract.ts";

function httpServer(
	name: string,
	url: string,
	options: { oauth?: boolean; bearerTokenEnv?: string; headers?: Record<string, string> } = {},
): McpServerConfig {
	return {
		name,
		transport: { kind: "http", url, headers: options.headers ?? {}, bearerTokenEnv: options.bearerTokenEnv },
		...(options.oauth ? { auth: "oauth" as const } : {}),
		capabilities: ALL_CAPABILITIES,
		lifecycle: "lazy",
		idleTimeoutMinutes: 10,
	};
}

describe("resolveAuthorizationHeaders", () => {
	it("keeps static headers when nothing else is configured", () => {
		const configured = httpServer("srv", "https://api.example/mcp", { headers: { "x-api": "1" } });
		expect(resolveAuthorizationHeaders(configured)).toEqual({ "x-api": "1" });
	});

	it("lets the named bearer env var override a static header", () => {
		vi.stubEnv("SOME_TOKEN", "env-token");
		try {
			const configured = httpServer("srv", "https://api.example/mcp", {
				headers: { authorization: "Bearer static" },
				bearerTokenEnv: "SOME_TOKEN",
			});
			expect(resolveAuthorizationHeaders(configured).Authorization).toBe("Bearer env-token");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("lets the OAuth token override both, per the spec's precedence order", () => {
		vi.stubEnv("SOME_TOKEN", "env-token");
		try {
			const configured = httpServer("srv", "https://api.example/mcp", {
				headers: { authorization: "Bearer static" },
				bearerTokenEnv: "SOME_TOKEN",
			});
			expect(resolveAuthorizationHeaders(configured, "Bearer store-token").Authorization).toBe("Bearer store-token");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("createSessionMcpConnector", () => {
	it("fails an OAuth server closed before any connection when no credentials exist", async () => {
		const connector = createSessionMcpConnector({});
		const error = await connector(httpServer("srv", "http://127.0.0.1:9/mcp", { oauth: true })).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(McpOAuthRequiredError);
		expect((error as Error).message).toContain("apex-code mcp auth srv");
	});

	it("never consults the credential store for a server without auth: oauth", async () => {
		const credentials = AuthStorage.inMemory();
		const read = vi.spyOn(credentials, "read");
		const connector = createSessionMcpConnector({ credentials });
		// The connect itself fails against a closed port; the point is that the store
		// was never asked, so the non-OAuth path is byte-identical to before.
		await connector(httpServer("srv", "http://127.0.0.1:9/mcp")).catch(() => undefined);
		expect(read).not.toHaveBeenCalled();
	});

	it("connects an OAuth server with the refreshed token", async () => {
		const credentials = AuthStorage.inMemory({
			"mcp/srv": {
				type: "oauth",
				access: "old",
				refresh: "rt",
				expires: Date.now() - 1_000,
				tokenEndpoint: "https://as.example/token",
				resource: "http://127.0.0.1:9/mcp",
				clientId: "c1",
			} as never,
		});
		const fetchImpl = vi.fn(async (): Promise<Response> => {
			return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const connector = createSessionMcpConnector({ credentials, fetch: fetchImpl });
		// The connect against a closed port fails after the refresh; the rotated token
		// must already be persisted by then.
		await connector(httpServer("srv", "http://127.0.0.1:9/mcp", { oauth: true })).catch(() => undefined);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const rotated = await credentials.read("mcp/srv");
		expect(rotated?.type === "oauth" && rotated.access).toBe("fresh");
	});
});
