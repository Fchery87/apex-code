/**
 * Deferred-schema resolution — announce-by-name projection and explicit load path.
 *
 * Ordering context (`docs/architecture/contracts.md` § 2, "Context pipeline order —
 * settled"): deferred-schema resolution is the first of three stages applied at the
 * `transformContext` seam —
 *
 *   deferred-schema resolution → tool-result eviction → compaction
 *
 * — because it changes the static prefix (system prompt + tool definitions) that both
 * later stages measure themselves against. This module implements only that first
 * stage's two primitives; wiring it into `transformContext` is task 3.3.
 *
 * `ContextSpec.deferSchema` (`core/tools/contract.ts`) is the per-tool flag this
 * module reads: a tool with `deferSchema: true` is announced to the model by name and
 * description only — its full JSON parameter schema is withheld from the static
 * prefix — and materialized on demand through `loadDeferredSchema` when a later
 * wiring stage needs the real schema for a tool the model decided to call.
 *
 * Both functions are pure: everything they need arrives as a parameter, nothing is
 * read from a global tool registry, and neither performs I/O.
 */

/**
 * Minimal shape this module needs from a tool definition. Any richer type — e.g.
 * `ApexToolDefinition` from `core/tools/contract.ts` — satisfies this structurally,
 * so a caller can pass its real tool-definition array directly with no adapter.
 */
export interface DeferrableTool {
	name: string;
	description: string;
	/**
	 * The tool's full parameter schema (a TypeBox `TSchema` on `ApexToolDefinition` in
	 * this repo, but this module treats it as opaque — it never inspects, validates,
	 * or transforms its shape, only copies or withholds it whole).
	 */
	parameters: unknown;
	contract: {
		context: {
			deferSchema: boolean;
		};
	};
}

/**
 * A tool as announced to the model: name, description, and a parameter schema that is
 * either the tool's real schema (`deferSchema: false`) or the stub below
 * (`deferSchema: true`).
 */
export interface AnnouncedTool {
	name: string;
	description: string;
	parameters: unknown;
}

/**
 * Stub schema substituted for a deferred tool's real parameters in the announce-by-name
 * projection. An empty object schema rather than `undefined`/omission, so a provider
 * that requires a `parameters`/`input_schema` field on every tool entry still receives
 * a well-formed one.
 */
export const DEFERRED_SCHEMA_STUB: Readonly<{ type: "object"; properties: Record<string, never> }> = Object.freeze({
	type: "object",
	properties: {},
});

/**
 * Announce-by-name projection (context pipeline stage 1, "deferred-schema
 * resolution").
 *
 * Tools with `contract.context.deferSchema === true` are represented by name and
 * description only; their `parameters` field is replaced with `DEFERRED_SCHEMA_STUB`.
 * Tools with `deferSchema === false` pass through with their real schema unchanged
 * (the same reference, so deep- and reference-equality both hold).
 *
 * Pure: same length and order as `tools` in, no field other than `parameters` is
 * altered, no global state is read.
 */
export function announceToolsByName<T extends DeferrableTool>(tools: readonly T[]): AnnouncedTool[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.contract.context.deferSchema ? DEFERRED_SCHEMA_STUB : tool.parameters,
	}));
}

/**
 * Explicit load path (context pipeline stage 1's counterpart): given a tool name,
 * returns its real, full parameter schema — the mechanism a later wiring stage
 * (task 3.3) calls when the model needs the real schema for a deferred tool it
 * decided to call.
 *
 * Looks up `name` in `tools` and returns that tool's real `parameters`, regardless of
 * whether `deferSchema` is `true` or `false` — a tool that never deferred its schema
 * still has a well-defined "real schema" to return, and the caller should not have to
 * branch on `deferSchema` before loading.
 *
 * Throws if no tool named `name` exists in `tools`. Does not throw for a tool whose
 * `deferSchema` is `false`; that is a valid no-op returning the same schema the
 * announce-by-name projection already showed for it.
 */
export function loadDeferredSchema<T extends DeferrableTool>(tools: readonly T[], name: string): unknown {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) {
		throw new Error(`loadDeferredSchema: no tool named "${name}" in the provided definitions`);
	}
	return tool.parameters;
}
