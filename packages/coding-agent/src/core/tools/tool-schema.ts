import type { AgentToolResult } from "apex-code-agent-core";
import { type Static, Type } from "typebox";
import type { ApexToolDefinition } from "./contract.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const toolSchema = Type.Object({
	name: Type.String({ description: "Name of the active tool whose parameter schema is needed." }),
});

type ToolSchemaInput = Static<typeof toolSchema>;

export interface ToolSchemaTarget {
	name: string;
	parameters: unknown;
}

export interface ToolSchemaResolver {
	getTool(name: string): ToolSchemaTarget | undefined;
	markLoaded(name: string): void;
}

/** Resolve one active tool schema and record that it is available on the next request. */
export function loadToolSchema(resolver: ToolSchemaResolver, name: string): ToolSchemaTarget {
	const target = resolver.getTool(name);
	if (!target) {
		throw new Error(`Cannot load schema for inactive or unknown tool "${name}"`);
	}
	resolver.markLoaded(name);
	return target;
}

/** Create the model-callable schema loader settled by ADR 0011. */
export function createToolSchemaToolDefinition(resolver: ToolSchemaResolver): ApexToolDefinition<typeof toolSchema> {
	return {
		name: "tool_schema",
		label: "tool_schema",
		description: "Load the full parameter schema for an active tool before calling it.",
		parameters: toolSchema,
		contract: {
			capabilities: new Set(),
			permission: {
				defaultBehavior: "allow",
				matches: () => false,
				describe: () => "Loading a tool parameter schema",
				ruleForCall: () => null,
			},
			context: { resultRecoverable: true, deferSchema: false },
			evidence: { emits: new Set(), capture: () => [] },
		},
		async execute(_toolCallId, { name }: ToolSchemaInput): Promise<AgentToolResult<unknown>> {
			const target = loadToolSchema(resolver, name);
			return {
				content: [{ type: "text", text: JSON.stringify({ name: target.name, parameters: target.parameters }) }],
				details: { name: target.name, parameters: target.parameters },
			};
		},
	};
}

export function createToolSchemaTool(resolver: ToolSchemaResolver) {
	return wrapToolDefinition(createToolSchemaToolDefinition(resolver));
}
