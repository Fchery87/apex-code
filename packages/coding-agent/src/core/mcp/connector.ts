/**
 * The MCP SDK lives here and nowhere else.
 *
 * Everything above this file talks to `McpConnection`, so the lifecycle logic, the
 * proxy tool, and their tests never import the SDK or start a process. This module is
 * the boundary where an external protocol becomes an internal type.
 */

import type { CredentialStore } from "@earendil-works/pi-ai";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { APP_NAME, VERSION } from "../../config.ts";
import type { FetchLike } from "./oauth/discover.ts";
import { authRequired, ensureFreshServerToken } from "./oauth/mcp-token.ts";
import type { CachedTool, McpCallResult, McpConnection, McpConnector, McpServerConfig } from "./types.ts";

/**
 * Authorization for one HTTP connection, in precedence order: a static configured
 * header, then a named bearer env var, then the credential store's OAuth token.
 * Later wins, because each later source is the more deliberately configured one.
 */
export function resolveAuthorizationHeaders(
	server: McpServerConfig,
	oauthAuthorization?: string,
): Record<string, string> {
	if (server.transport.kind !== "http") return {};
	const headers = { ...server.transport.headers };
	const token = server.transport.bearerTokenEnv ? process.env[server.transport.bearerTokenEnv] : undefined;
	if (token) headers.Authorization = `Bearer ${token}`;
	if (oauthAuthorization) headers.Authorization = oauthAuthorization;
	return headers;
}

function createTransport(server: McpServerConfig, oauthAuthorization?: string) {
	if (server.transport.kind === "stdio") {
		return new StdioClientTransport({
			command: server.transport.command,
			args: server.transport.args,
			env: { ...process.env, ...server.transport.env } as Record<string, string>,
			cwd: server.transport.cwd,
		});
	}

	return new StreamableHTTPClientTransport(new URL(server.transport.url), {
		requestInit: { headers: resolveAuthorizationHeaders(server, oauthAuthorization) },
	});
}

/**
 * Server content arrives as a heterogeneous array. Only text is carried forward; an
 * image or an embedded resource is named rather than dropped silently, so a caller
 * can tell the difference between "returned nothing" and "returned something we do
 * not render yet".
 */
function toCallResult(raw: unknown): McpCallResult {
	const result = raw as { content?: unknown; isError?: unknown };
	const parts = Array.isArray(result?.content) ? result.content : [];
	const content = parts.map((part) => {
		const item = part as { type?: unknown; text?: unknown };
		if (item?.type === "text" && typeof item.text === "string") {
			return { type: "text" as const, text: item.text };
		}
		return { type: "text" as const, text: `[${String(item?.type ?? "unknown")} content omitted]` };
	});

	return {
		content: content.length > 0 ? content : [{ type: "text" as const, text: "(no content)" }],
		isError: result?.isError === true,
	};
}

export async function connectMcpServer(server: McpServerConfig, oauthAuthorization?: string): Promise<McpConnection> {
	const client = new Client({ name: APP_NAME, version: VERSION });
	await client.connect(createTransport(server, oauthAuthorization));

	return {
		async listTools(): Promise<CachedTool[]> {
			const { tools } = await client.listTools();
			return tools.map((tool) => ({
				server: server.name,
				name: tool.name,
				description: tool.description ?? "",
				inputSchema: tool.inputSchema,
			}));
		},
		async callTool(name: string, args: unknown): Promise<McpCallResult> {
			return toCallResult(await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }));
		},
		async close(): Promise<void> {
			await client.close();
		},
	};
}

export interface SessionMcpConnectorOptions {
	/**
	 * The session's credential store: `AuthStorage` on the host, `SandboxAuthStorage`
	 * in a sandboxed child (reads from the projection, writes through the supervisor
	 * channel). OAuth-configured servers without one fail closed.
	 */
	credentials?: CredentialStore;
	now?: () => number;
	fetch?: FetchLike;
}

/**
 * The session connector: resolves OAuth tokens for servers configured with
 * `auth: "oauth"`, and behaves exactly like `connectMcpServer` for everything else.
 * A missing authorization throws before the transport is constructed, so no OAuth
 * endpoint is ever contacted from a tool call path (spec 2026-09-01-mcp-oauth).
 */
export function createSessionMcpConnector(options: SessionMcpConnectorOptions = {}): McpConnector {
	return async (server) => {
		if (server.transport.kind === "http" && server.auth === "oauth") {
			if (!options.credentials) throw authRequired(server.name);
			const accessToken = await ensureFreshServerToken({
				server,
				credentials: options.credentials,
				now: options.now,
				fetch: options.fetch,
			});
			return connectMcpServer(server, `Bearer ${accessToken}`);
		}
		return connectMcpServer(server);
	};
}
