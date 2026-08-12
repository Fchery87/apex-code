/**
 * The permission gate: composes rule resolution (rules.ts), mode overlay
 * (modes.ts), and interactive escalation (responder.ts) into a single decision,
 * and adapts that decision to the `beforeToolCall` seam `agent-core` already
 * exposes (packages/agent/src/agent-loop.ts). No new hook, no agent-core change.
 *
 * Tool execution has exactly one call site downstream of this hook
 * (`executePreparedToolCall`, fed only by the function that runs `beforeToolCall`),
 * so wiring this in once at session setup is sufficient for "every registered tool
 * passes the gate" to be true by construction — the universal-gate test (invariant
 * 2) verifies this property holds, it does not have to work to make it hold.
 */

import type { BeforeToolCallContext, BeforeToolCallResult } from "apex-code-agent-core";
import type { ToolContract } from "../tools/contract.ts";
import { UNCLASSIFIED } from "../tools/contract.ts";
import { resolveWithMode } from "./modes.ts";
import type { PermissionResponder } from "./responder.ts";
import { resolvePermission } from "./rules.ts";
import type { PermissionMode, PermissionRuleStore } from "./store.ts";

export interface PermissionGateOptions {
	/** Resolve a tool's contract by name. Foreign tools with no contract get UNCLASSIFIED, never rejected or silently defaulted (ADR 0010). */
	getContract: (toolName: string) => ToolContract | undefined;
	store: PermissionRuleStore;
	getMode: () => PermissionMode | Promise<PermissionMode>;
	/** Absent in a non-interactive session: an `ask` resolution then fails closed (deny). */
	responder?: PermissionResponder;
	/** Resolves a responder at call time because the interactive UI binds after session construction. */
	getResponder?: () => PermissionResponder | undefined;
}

export interface GateDecision {
	block: boolean;
	reason?: string;
}

function describeDecision(contract: ToolContract, toolName: string, ruleContent: string | undefined): string {
	if (ruleContent !== undefined) return contract.permission.describe(ruleContent);
	return `${toolName} is not permitted by the current permission configuration.`;
}

/** Pure decision function, independent of the beforeToolCall adapter shape below — the part under direct test. */
export async function evaluateToolCall(
	toolName: string,
	params: unknown,
	options: PermissionGateOptions,
): Promise<GateDecision> {
	const contract = options.getContract(toolName) ?? UNCLASSIFIED;
	const spec = contract.permission;
	const snapshot = await options.store.snapshot();
	if (snapshot.errors.length > 0) {
		const sources = [...new Set(snapshot.errors.map((entry) => entry.source))].join(", ");
		return {
			block: true,
			reason: `Permission configuration could not be loaded (${sources}); refusing to run ${toolName}.`,
		};
	}
	const ruleResolution = resolvePermission(snapshot.rules, toolName, spec, params as never);
	const resolution = resolveWithMode(await options.getMode(), ruleResolution, contract.capabilities);

	if (resolution.behavior === "allow") return { block: false };

	if (resolution.behavior === "deny") {
		return { block: true, reason: describeDecision(contract, toolName, resolution.rule?.ruleContent) };
	}

	// ask
	const responder = options.getResponder?.() ?? options.responder;
	if (!responder) {
		return {
			block: true,
			reason: `${toolName} requires approval, and no responder is available in this session.`,
		};
	}
	const ruleForCall = spec.ruleForCall(params as never);
	const answer = await responder.ask({
		toolName,
		description: ruleForCall !== null ? spec.describe(ruleForCall) : `Run ${toolName}`,
	});
	if (!answer.allow) {
		return { block: true, reason: `${toolName} was declined.` };
	}
	if (answer.persist && ruleForCall !== null) {
		await options.store.apply({
			type: "addRules",
			destination: "session",
			rules: [{ toolName, behavior: "allow", ruleContent: ruleForCall }],
		});
	}
	return { block: false };
}

/** Adapts evaluateToolCall() to the beforeToolCall seam agent-core already exposes. */
export function createPermissionGate(
	options: PermissionGateOptions,
): (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined> {
	return async ({ toolCall, args }) => {
		const decision = await evaluateToolCall(toolCall.name, args, options);
		return decision.block ? { block: true, reason: decision.reason } : undefined;
	};
}
