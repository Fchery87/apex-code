/**
 * The tool contract for the `mcp` proxy tool (ADR 0010).
 *
 * This module is the reason MCP is built into Apex Code rather than adopted as an
 * extension. A tool registered from outside the repo cannot supply a contract, so it
 * resolves `UNCLASSIFIED`: every capability, `ask` by default, and rule matching by
 * exact serialized arguments. Under that fallback a second call with different
 * arguments prompts again and no result is ever evictable.
 *
 * The grammar is owned here and nowhere else. The permission engine resolves
 * precedence between rules and never learns what one means.
 */

import type { Capability, ToolContract } from "../tools/contract.ts";
import { ALL_CAPABILITIES } from "../tools/contract.ts";
import type { McpToolDetails, McpToolParams, mcpToolSchema } from "./schema.ts";
import type { McpServerConfig } from "./types.ts";

/** Rule covering the metadata actions, which read the local cache and reach no server. */
export const METADATA_RULE = "Mcp(metadata)";

const RULE_PATTERN = /^Mcp\(([^():*\s]+):([^():\s]+)\)$/;

function isCall(params: McpToolParams): params is McpToolParams & { tool: string } {
	return typeof params.tool === "string" && params.tool.length > 0;
}

/** `<server>:<tool>`, the form the model calls and the form a rule names. */
function splitQualifiedName(qualified: string): { server: string; tool: string } | undefined {
	const index = qualified.indexOf(":");
	if (index <= 0 || index === qualified.length - 1) return undefined;
	return { server: qualified.slice(0, index), tool: qualified.slice(index + 1) };
}

function matches(ruleContent: string, params: McpToolParams): boolean {
	if (ruleContent === METADATA_RULE) return !isCall(params);
	if (!isCall(params)) return false;

	const rule = RULE_PATTERN.exec(ruleContent);
	if (!rule) return false;
	const [, ruleServer, ruleTool] = rule;

	const target = splitQualifiedName(params.tool);
	if (!target) return false;

	if (ruleServer !== target.server) return false;
	return ruleTool === "*" || ruleTool === target.tool;
}

function ruleForCall(params: McpToolParams): string | null {
	if (!isCall(params)) return METADATA_RULE;
	const target = splitQualifiedName(params.tool);
	return target ? `Mcp(${target.server}:${target.tool})` : null;
}

function describe(ruleContent: string): string {
	if (ruleContent === METADATA_RULE) return "Searching and describing MCP tools (no server is contacted)";

	const rule = RULE_PATTERN.exec(ruleContent);
	if (!rule) return `Unrecognized MCP rule: ${ruleContent}`;
	const [, server, tool] = rule;
	return tool === "*"
		? `Calling any tool on the "${server}" MCP server`
		: `Calling "${tool}" on the "${server}" MCP server`;
}

/**
 * One proxy tool carries one capability set, and that set feeds the delegation
 * ceiling (ADR 0008) and mode resolution. The union across configured servers is the
 * only sound answer: narrower would understate what a call can do, and a fixed full
 * set would ignore what a user took the trouble to declare.
 */
function unionCapabilities(servers: Iterable<McpServerConfig>): ReadonlySet<Capability> {
	const union = new Set<Capability>();
	for (const server of servers) {
		for (const capability of server.capabilities) union.add(capability);
		if (union.size === ALL_CAPABILITIES.size) return ALL_CAPABILITIES;
	}
	return union;
}

export function createMcpToolContract(
	servers: ReadonlyMap<string, McpServerConfig>,
): ToolContract<typeof mcpToolSchema, McpToolDetails> {
	return {
		capabilities: unionCapabilities(servers.values()),
		permission: {
			defaultBehavior: "ask",
			matches,
			describe,
			ruleForCall,
		},
		context: { resultRecoverable: false, deferSchema: true },
		evidence: { emits: new Set(), capture: () => [] },
	};
}
