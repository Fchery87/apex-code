import type { AgentTool } from "apex-code-agent-core";
import type { TSchema } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

/**
 * Wrap a ToolDefinition into an AgentTool for the core runtime.
 *
 * `TParams` is generic here rather than fixed to `any`, so a caller passing a
 * concretely-typed definition (e.g. one carrying a `contract`, per ADR 0010) gets
 * `TParams` inferred as that concrete schema. Fixing it to `any` would instantiate
 * every optional renderer's `Static<TParams>` as `Static<any>`, which TypeScript
 * does not treat as `any` — it structurally resolves to `unknown` — and that turns a
 * harmless assignability check into a real error for any definition with a
 * concretely-typed `renderCall`/`renderResult`.
 */
export function wrapToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown>(
	definition: ToolDefinition<TParams, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<TParams, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionContext) =>
			definition.execute(toolCallId, params, signal, onUpdate, ctx ?? (ctxFactory?.() as ExtensionContext)),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
