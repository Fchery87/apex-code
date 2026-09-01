/**
 * One tool for every MCP server, instead of one tool per server tool.
 *
 * Registering each server tool individually costs 150-300 prompt tokens apiece, and
 * two ordinary servers would exceed the whole static-prefix budget before a
 * conversation starts. The proxy costs one announced name and this description,
 * because its schema defers.
 *
 * `search` and `describe` read the disk cache and reach no server. Only a `tool` call
 * connects, which is what makes discovery free and is why the two have separate
 * permission rules (ADR 0025).
 */

import type { AgentToolResult } from "apex-code-agent-core";
import type { ApexToolDefinition } from "../tools/contract.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { createMcpToolContract } from "./contract.ts";
import type { McpMetadataCache } from "./metadata-cache.ts";
import { McpOAuthRefreshError, McpOAuthRequiredError } from "./oauth/mcp-token.ts";
import { type McpToolDetails, type McpToolParams, mcpToolSchema } from "./schema.ts";
import type { McpServerManager } from "./server-manager.ts";
import type { CachedTool, McpServerConfig } from "./types.ts";

export const MCP_TOOL_NAME = "mcp";

const MAX_RESULTS = 25;

const DESCRIPTION =
	"Use tools provided by configured MCP servers. " +
	'Search with {"search":"keyword"}, list one server with {"server":"name"}, ' +
	'see a tool\'s full schema with {"describe":"server:tool"}, ' +
	'and call one with {"tool":"server:tool","args":{...}}. ' +
	"Search and describe read a local cache and never start a server, so discovery is free. " +
	"Always describe a tool before calling it for the first time.";

function text(body: string): AgentToolResult<McpToolDetails>["content"] {
	return [{ type: "text", text: body }];
}

function qualified(tool: CachedTool): string {
	return `${tool.server}:${tool.name}`;
}

/** Substring scoring, weighted to the name, which is what the model searched for. */
function score(tool: CachedTool, needle: string): number {
	const name = qualified(tool).toLowerCase();
	const description = tool.description.toLowerCase();
	if (name === needle) return 100;
	if (name.includes(needle)) return 50;
	if (description.includes(needle)) return 10;
	return 0;
}

function renderList(tools: readonly CachedTool[]): string {
	return tools.map((tool) => `${qualified(tool)}: ${tool.description}`).join("\n");
}

function nearest(tools: readonly CachedTool[], target: string): CachedTool[] {
	const needle = target.toLowerCase();
	const stem = needle.slice(0, Math.max(3, Math.floor(needle.length * 0.6)));
	return tools.filter((tool) => qualified(tool).toLowerCase().includes(stem)).slice(0, 5);
}

export interface McpToolOptions {
	servers: ReadonlyMap<string, McpServerConfig>;
	cache: McpMetadataCache;
	manager: McpServerManager;
}

export function createMcpToolDefinition(
	options: McpToolOptions,
): ApexToolDefinition<typeof mcpToolSchema, McpToolDetails> {
	const { servers, cache, manager } = options;

	return {
		name: MCP_TOOL_NAME,
		label: "mcp",
		description: DESCRIPTION,
		promptSnippet: "Call tools on configured MCP servers",
		parameters: mcpToolSchema,
		contract: createMcpToolContract(servers),
		async execute(_id, params: McpToolParams): Promise<AgentToolResult<McpToolDetails>> {
			if (params.tool) return callTool(params.tool, params.args);
			if (params.describe) return describeTool(params.describe);
			if (params.search !== undefined) return searchTools(params.search, params.server);
			if (params.server) return listServer(params.server);

			return {
				content: text('Provide one of "search", "server", "describe", or "tool".'),
				details: { action: "search", server: undefined, tool: undefined },
			};
		},
	};

	function searchTools(needle: string, serverFilter?: string): AgentToolResult<McpToolDetails> {
		const pool = serverFilter ? cache.all().filter((tool) => tool.server === serverFilter) : cache.all();
		const lowered = needle.toLowerCase();
		const ranked = pool
			.map((tool) => ({ tool, rank: score(tool, lowered) }))
			.filter((entry) => entry.rank > 0)
			.sort((a, b) => b.rank - a.rank)
			.slice(0, MAX_RESULTS)
			.map((entry) => entry.tool);

		return {
			content: text(
				ranked.length > 0
					? renderList(ranked)
					: `No cached MCP tool matches "${needle}". Configured servers: ${[...servers.keys()].join(", ") || "none"}.`,
			),
			details: { action: "search", server: serverFilter, tool: undefined },
		};
	}

	function listServer(name: string): AgentToolResult<McpToolDetails> {
		if (!servers.has(name)) {
			return {
				content: text(
					`MCP server "${name}" is not configured. Configured servers: ${[...servers.keys()].join(", ") || "none"}.`,
				),
				details: { action: "list", server: name, tool: undefined },
			};
		}

		const tools = cache.all().filter((tool) => tool.server === name);
		return {
			content: text(
				tools.length > 0
					? renderList(tools)
					: `No cached tools for "${name}" yet. Tools are cached the first time the server is called, so call a known tool on it, or set "lifecycle": "eager" for this server in .mcp.json to have them cached at startup.`,
			),
			details: { action: "list", server: name, tool: undefined },
		};
	}

	function describeTool(target: string): AgentToolResult<McpToolDetails> {
		const found = cache.all().find((tool) => qualified(tool) === target);
		if (!found) {
			const suggestions = nearest(cache.all(), target);
			return {
				content: text(
					suggestions.length > 0
						? `No cached tool named "${target}". Did you mean:\n${renderList(suggestions)}`
						: `No cached tool named "${target}". Search with {"search":"keyword"}.`,
				),
				details: { action: "describe", server: undefined, tool: target },
			};
		}

		return {
			content: text(
				`${qualified(found)}\n${found.description}\n\nInput schema:\n${JSON.stringify(found.inputSchema, null, 2)}`,
			),
			details: { action: "describe", server: found.server, tool: target },
		};
	}

	async function callTool(target: string, args: unknown): Promise<AgentToolResult<McpToolDetails>> {
		const separator = target.indexOf(":");
		const details: McpToolDetails = { action: "call", server: undefined, tool: target };
		if (separator <= 0) {
			return { content: text(`Tool must be qualified as "server:tool". Received "${target}".`), details };
		}

		const serverName = target.slice(0, separator);
		const toolName = target.slice(separator + 1);
		details.server = serverName;

		if (!servers.has(serverName)) {
			return {
				content: text(
					`MCP server "${serverName}" is not configured. Configured servers: ${[...servers.keys()].join(", ") || "none"}.`,
				),
				details,
			};
		}

		try {
			const result = await manager.withConnection(serverName, async (connection) => {
				// An empty list is a fact about the server, not a failed read. Keeping the
				// previous entry would leave search advertising tools that no longer exist.
				const fresh = await connection.listTools();
				cache.set(servers.get(serverName) as McpServerConfig, fresh);
				cache.save();
				return connection.callTool(toolName, args);
			});

			// `AgentToolResult` has no error flag; a server-reported failure is marked in
			// the text so the model can see it failed without the turn being aborted.
			const content = result.isError
				? text(`Tool reported an error:\n${result.content.map((part) => part.text).join("\n")}`)
				: result.content;
			return { content, details };
		} catch (error) {
			// OAuth failures already carry the one action that helps (`apex-code mcp auth
			// <server>`); the generic "unavailable" wrapper would bury it.
			if (error instanceof McpOAuthRequiredError || error instanceof McpOAuthRefreshError) {
				return { content: text(error.message), details };
			}
			// A failed server is reported, not retried: the manager holds it in `failed`
			// with a backoff window so one broken server cannot cost every call a spawn.
			return {
				content: text(
					`MCP server "${serverName}" is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				),
				details,
			};
		}
	}
}

export function createMcpTool(options: McpToolOptions) {
	return wrapToolDefinition(createMcpToolDefinition(options));
}
