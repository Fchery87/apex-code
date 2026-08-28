/**
 * The `mcp` tool's parameter schema, and the single source of its param type.
 *
 * It lives apart from the tool itself so the contract (`contract.ts`) can type its
 * permission grammar against the same shape without importing the tool, which would
 * be a cycle: the tool needs the contract.
 */

import { type Static, Type } from "typebox";

export const mcpToolSchema = Type.Object({
	search: Type.Optional(
		Type.String({
			description:
				"Find tools across configured MCP servers by keyword. Reads a local cache, so it works without starting a server.",
		}),
	),
	server: Type.Optional(
		Type.String({ description: "Restrict a search to one server, or list that server's tools when used alone." }),
	),
	describe: Type.Optional(
		Type.String({ description: 'Show one tool\'s full input schema. Qualified as "<server>:<tool>".' }),
	),
	tool: Type.Optional(
		Type.String({
			description: 'The tool to call, qualified as "<server>:<tool>". Requires the server to be reachable.',
		}),
	),
	args: Type.Optional(Type.Unknown({ description: "Arguments for the called tool, matching its input schema." })),
});

export type McpToolParams = Static<typeof mcpToolSchema>;

export interface McpToolDetails {
	action: "search" | "describe" | "list" | "call";
	server: string | undefined;
	tool: string | undefined;
}
