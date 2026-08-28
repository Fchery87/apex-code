/**
 * The MCP SDK lives here and nowhere else.
 *
 * Everything above this file talks to `McpConnection`, so the lifecycle logic, the
 * proxy tool, and their tests never import the SDK or start a process. This module is
 * the boundary where an external protocol becomes an internal type.
 */

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { APP_NAME, VERSION } from "../../config.ts";
import type { CachedTool, McpCallResult, McpConnection, McpConnector, McpServerConfig } from "./types.ts";

function createTransport(server: McpServerConfig) {
	if (server.transport.kind === "stdio") {
		return new StdioClientTransport({
			command: server.transport.command,
			args: server.transport.args,
			env: { ...process.env, ...server.transport.env } as Record<string, string>,
			cwd: server.transport.cwd,
		});
	}

	const headers = { ...server.transport.headers };
	const token = server.transport.bearerTokenEnv ? process.env[server.transport.bearerTokenEnv] : undefined;
	if (token) headers.Authorization = `Bearer ${token}`;

	return new StreamableHTTPClientTransport(new URL(server.transport.url), {
		requestInit: { headers },
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

export const connectMcpServer: McpConnector = async (server: McpServerConfig): Promise<McpConnection> => {
	const client = new Client({ name: APP_NAME, version: VERSION });
	await client.connect(createTransport(server));

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
};
