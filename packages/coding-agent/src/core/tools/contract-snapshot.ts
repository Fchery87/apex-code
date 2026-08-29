/**
 * The one projection ADR 0010 names. `AGENTS.md` § Tools states the rule this file
 * implements: never re-derive a tool's capability, risk, or permission
 * classification, because a second independent classification is the drift ADR 0010
 * exists to prevent.
 *
 * This describes; it never enforces. Nothing it returns is an authorization input,
 * and the enforcement paths stay where they are: `core/context/pipeline.ts` and
 * `core/context/eviction.ts` consume a `contractLookup` directly and apply their own
 * conservative defaults, which ADR 0010 permits precisely because they enforce.
 *
 * It computes no classification of its own. Every value below is either read off the
 * declared `contract` or taken from the shared `UNCLASSIFIED` fallback. A future
 * change that adds a branch here inspecting a tool's name or behaviour to decide
 * something has turned the projection into the second classifier it replaces.
 */

import type { Capability, EvidenceKind, PermissionBehavior, ToolContract } from "./contract.ts";
import { UNCLASSIFIED } from "./contract.ts";

/** One tool as every describing surface sees it. Arrays, not sets, so it is comparable and serializable. */
export interface ToolContractSnapshotEntry {
	readonly name: string;
	/**
	 * True when the tool declared no contract and is standing on `UNCLASSIFIED`.
	 *
	 * Reported rather than merely applied: contracts.md invariant 1 requires it to be
	 * visible wherever the registry is described, because a conservative default nobody
	 * can see is indistinguishable from a bug.
	 */
	readonly unclassified: boolean;
	readonly capabilities: readonly Capability[];
	readonly permission: { readonly defaultBehavior: PermissionBehavior };
	readonly context: {
		readonly resultRecoverable: boolean;
		readonly deferSchema: boolean;
		readonly outputBudgetTokens?: number;
	};
	readonly evidence: { readonly emits: readonly EvidenceKind[] };
}

/** The shape this reads. Anything without `contract` is foreign and lands on the fallback. */
interface MaybeContracted {
	readonly name: string;
	readonly contract?: ToolContract;
}

/**
 * The one place that decides whether a tool declared a contract.
 *
 * Exported because `getAllTools` needs the same answer. Two `!("contract" in x)` checks
 * in two files is the shape of the drift ADR 0010 names, even while they agree.
 */
export function isUnclassifiedTool(tool: MaybeContracted): boolean {
	return !("contract" in tool) || tool.contract === undefined;
}

export function buildToolContractSnapshot(tools: readonly MaybeContracted[]): ToolContractSnapshotEntry[] {
	return tools.map((tool) => {
		const unclassified = isUnclassifiedTool(tool);
		const contract = unclassified ? UNCLASSIFIED : (tool.contract as ToolContract);

		return {
			name: tool.name,
			unclassified,
			capabilities: [...contract.capabilities],
			permission: { defaultBehavior: contract.permission.defaultBehavior },
			context: {
				resultRecoverable: contract.context.resultRecoverable,
				deferSchema: contract.context.deferSchema,
				...(contract.context.outputBudgetTokens === undefined
					? {}
					: { outputBudgetTokens: contract.context.outputBudgetTokens }),
			},
			evidence: { emits: [...contract.evidence.emits] },
		};
	});
}

/** The names a describing surface must report, per contracts.md invariant 1. */
export function unclassifiedToolNames(snapshot: readonly ToolContractSnapshotEntry[]): string[] {
	return snapshot.filter((entry) => entry.unclassified).map((entry) => entry.name);
}
