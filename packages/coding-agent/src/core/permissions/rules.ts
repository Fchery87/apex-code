/**
 * The permission rule model (ADR 0004). Pure and tool-agnostic: this module never
 * inspects a `ruleContent` grammar itself — it only calls the tool's own
 * `PermissionSpec.matches()`, per ADR 0010's rule that a tool owns both directions
 * of its grammar and the engine never accumulates tool-specific matching.
 */

import type { Static, TSchema } from "typebox";
import type { PermissionBehavior, PermissionSpec } from "../tools/contract.ts";

/**
 * Highest to lowest precedence. `flag` outranks config because it is a deliberate
 * per-run operator override; `cliArg` sits below config because it is a per-run
 * *default*, not an override. See ADR 0004 for why each source sits where it does.
 */
export const PERMISSION_SOURCES = [
	"policy",
	"flag",
	"local",
	"project",
	"user",
	"cliArg",
	"command",
	"session",
] as const;

export type PermissionSource = (typeof PERMISSION_SOURCES)[number];

export interface PermissionRule {
	source: PermissionSource;
	behavior: PermissionBehavior;
	toolName: string;
	/** Undefined matches every call to this tool — a tool-wide rule. */
	ruleContent?: string;
}

export interface PermissionResolution {
	behavior: PermissionBehavior;
	/** The winning rule, or undefined when no rule matched and the tool's own default applied. */
	rule?: PermissionRule;
}

const SOURCE_RANK = new Map<PermissionSource, number>(PERMISSION_SOURCES.map((source, index) => [source, index]));

function ruleMatchesCall<TParams extends TSchema>(
	rule: PermissionRule,
	spec: PermissionSpec<TParams>,
	params: Static<TParams>,
): boolean {
	if (rule.ruleContent === undefined) return true;
	return spec.matches(rule.ruleContent, params);
}

/**
 * Deterministic tie-break for two matching rules at the *same* source, independent
 * of array order: a rule with `ruleContent` (specific) outranks a tool-wide rule
 * with none (blanket); between two specific rules, the longer `ruleContent` wins
 * (a proxy for "more specific"); a final lexical comparison guarantees a total,
 * order-independent order for the residual case of equal-length content.
 */
function compareSameSourceRules(a: PermissionRule, b: PermissionRule): number {
	const aSpecific = a.ruleContent !== undefined;
	const bSpecific = b.ruleContent !== undefined;
	if (aSpecific !== bSpecific) return aSpecific ? -1 : 1; // specific wins (negative = a first)
	if (!aSpecific) return 0; // both blanket at the same source: no further distinction needed
	const lengthDelta = (b.ruleContent as string).length - (a.ruleContent as string).length;
	if (lengthDelta !== 0) return lengthDelta;
	return (a.ruleContent as string).localeCompare(b.ruleContent as string);
}

/**
 * Resolve the effective behavior for one call. The highest-precedence *matching*
 * rule wins, whatever its behavior — `deny` does not automatically outrank `allow`.
 * With no matching rule, the tool's own `defaultBehavior` applies.
 */
export function resolvePermission<TParams extends TSchema>(
	rules: readonly PermissionRule[],
	toolName: string,
	spec: PermissionSpec<TParams>,
	params: Static<TParams>,
): PermissionResolution {
	let winner: PermissionRule | undefined;
	for (const candidate of rules) {
		if (candidate.toolName !== toolName) continue;
		if (!ruleMatchesCall(candidate, spec, params)) continue;
		if (!winner) {
			winner = candidate;
			continue;
		}
		const candidateRank = SOURCE_RANK.get(candidate.source) ?? Number.POSITIVE_INFINITY;
		const winnerRank = SOURCE_RANK.get(winner.source) ?? Number.POSITIVE_INFINITY;
		if (candidateRank < winnerRank) {
			winner = candidate;
		} else if (candidateRank === winnerRank && compareSameSourceRules(candidate, winner) < 0) {
			winner = candidate;
		}
	}
	return winner
		? { behavior: winner.behavior, rule: winner }
		: { behavior: spec.defaultBehaviorFor?.(params) ?? spec.defaultBehavior };
}
