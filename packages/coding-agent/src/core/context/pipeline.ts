/**
 * Context pipeline wiring — shared by `AgentSession` (production) and the offline
 * replay harness (`src/testing/replay/runner.ts`), so there is exactly one
 * implementation of "how deferred-schema resolution and eviction attach to an
 * `Agent`" rather than two independently maintained copies.
 *
 * Implements the ordering settled in `docs/architecture/contracts.md` § 2:
 * deferred-schema resolution → tool-result eviction → compaction. Compaction runs
 * reactively from its own existing seam (`_checkCompaction` in `agent-session.ts`)
 * and is untouched here; this module only adds the two stages that run *ahead of*
 * every LLM request, so that reactive check is reached less often because the
 * request it is reacting to is smaller.
 *
 * The two stages land in different seams because they operate on different halves
 * of the outbound request. Eviction is a pure function of `AgentMessage[]`, which is
 * exactly what `transformContext` sees, immediately before `convertToLlm` — so it is
 * wired there. Deferred-schema resolution operates on the *tool list*, not messages;
 * `transformContext`'s signature has no tools parameter, and `AgentContext.tools` is
 * a snapshot taken once per prompt rather than rebuilt per request. The seam that
 * actually sees the assembled outbound tool list on every request is
 * `streamFunction` — it receives the full `Context`, tools included, immediately
 * before the provider call — so the projection is applied there instead. Because the
 * two stages act on disjoint fields of the request with no data dependency between
 * them, this does not change the observable pipeline order.
 */

import type { Agent } from "apex-code-agent-core";
import { type DeferrableTool, announceToolsByName } from "./deferred-schemas.ts";
import { type ContractLookup, evictToolResults } from "./eviction.ts";

/**
 * Eviction-budget formula shared by every caller of `installContextPipeline`.
 * Compaction fires once total context tokens exceed `contextWindow - reserveTokens`
 * (`shouldCompact` in `core/compaction/compaction.ts`). Budgeting eviction — counted
 * purely against tool-result tokens, per `evictToolResults`'s own contract — at half
 * of that headroom leaves the other half free for system prompt and conversational
 * growth, so eviction (cheap, structure-preserving) gets a chance to shrink the
 * transcript before the expensive compaction stage is ever reached, matching
 * contracts.md § 2's "why this order" (eviction before compaction, so compaction is
 * reached later and less often).
 *
 * `Math.max(0, ...)` mirrors `shouldCompact`'s own behavior when `contextWindow` is
 * unknown (0): evict aggressively rather than not at all, rather than inventing a
 * different, unproven fallback.
 *
 * Production (`AgentSession`) calls this with the real model's `contextWindow` and
 * the user's configured `reserveTokens`. The offline replay harness deliberately
 * does *not* call this with the fixture model's `contextWindow` — see
 * `REPLAY_EVICTION_BUDGET` in `src/testing/replay/runner.ts` for why a dedicated
 * constant is used there instead.
 */
export function evictionBudget(contextWindow: number, reserveTokens: number): number {
	return Math.max(0, Math.floor((contextWindow - reserveTokens) / 2));
}

/**
 * Adapter between a caller's tool registry and `announceToolsByName`, which
 * operates on a minimal `DeferrableTool` shape that has no notion of a tool
 * registry. Only `parameters` is ever replaced; every other field of the outbound
 * tool (name, description, and on `AgentTool` specifically, `execute`, `label`,
 * etc.) passes through unchanged via the object spread.
 *
 * A tool with no entry in `contractLookup` (a foreign/unclassified tool) is treated
 * as `deferSchema: false` here — the safe default on this axis is to keep
 * describing it fully, the mirror image of eviction's "no contract => don't evict"
 * default: when unsure, don't withhold information the model needs.
 */
export function projectToolSchemas<T extends { name: string; description: string; parameters: unknown }>(
	tools: readonly T[],
	contractLookup: ContractLookup,
): T[] {
	const deferrable: DeferrableTool[] = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		contract: {
			context: {
				deferSchema: contractLookup(tool.name)?.context.deferSchema === true,
			},
		},
	}));
	const announced = announceToolsByName(deferrable);
	return tools.map((tool, index) => ({ ...tool, parameters: announced[index].parameters }));
}

export interface ContextPipelineOptions {
	/** Resolves a tool's contract; shared by both eviction and schema projection. */
	contractLookup: ContractLookup;
	/**
	 * Eviction budget as a thunk, not a plain number: `AgentSession`'s budget
	 * depends on `this.model` and `this.settingsManager`, both of which can change
	 * over the session's lifetime (model switch, settings edit), and is never
	 * cached. Evaluating it fresh on every request is what keeps eviction correct
	 * after either changes mid-session.
	 */
	evictionBudget: () => number;
}

/**
 * Installs the settled context pipeline (deferred-schema resolution → eviction)
 * onto `agent`, chaining onto whatever `transformContext` / `streamFunction` the
 * caller already installed rather than replacing it — the same pattern
 * `AgentSession._installAgentNextTurnRefresh` uses for `prepareNextTurnWithContext`.
 */
export function installContextPipeline(agent: Agent, options: ContextPipelineOptions): void {
	const { contractLookup, evictionBudget: getBudget } = options;

	const previousTransformContext = agent.transformContext;
	agent.transformContext = async (messages, signal) => {
		const afterPrevious = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
		return evictToolResults(afterPrevious, contractLookup, getBudget());
	};

	const previousStreamFunction = agent.streamFunction;
	agent.streamFunction = (model, context, streamOptions) => {
		if (!context.tools || context.tools.length === 0) {
			return previousStreamFunction(model, context, streamOptions);
		}
		return previousStreamFunction(
			model,
			{ ...context, tools: projectToolSchemas(context.tools, contractLookup) },
			streamOptions,
		);
	};
}
