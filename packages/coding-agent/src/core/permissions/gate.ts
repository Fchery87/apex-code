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
import { type PermissionSpec, resolveToolContract, type ToolContract } from "../tools/contract.ts";
import { resolveWithMode } from "./modes.ts";
import type { PermissionPreview, PermissionResponder } from "./responder.ts";
import { resolvePermission } from "./rules.ts";
import type { PermissionMode, PermissionRuleStore } from "./store.ts";

export interface PermissionGateOptions {
	/** Resolve a tool's contract by name. Foreign tools with no contract get UNCLASSIFIED, never rejected or silently defaulted (ADR 0010). */
	getContract: (toolName: string) => ToolContract | undefined;
	store: PermissionRuleStore;
	getMode: () => PermissionMode | Promise<PermissionMode>;
	/**
	 * The `--permission-mode` value, when one was passed. Not used to decide
	 * anything here — `getMode` already folds it in. It is carried so a UI that
	 * offers to change the mode can tell the user their write is outranked
	 * (permissions/startup.ts, resolveEffectiveModeWithOrigin).
	 */
	flagMode?: PermissionMode;
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

/**
 * A denial, plus whatever the user said to do instead.
 *
 * The reason becomes the blocked tool result the model reads, so guidance is
 * bounded here rather than pasted whole: it is user-entered free text on a path
 * that reaches the transcript.
 */
const MAX_GUIDANCE_CHARS = 400;

/**
 * Run the tool's preview producer, if it declares one, on the ask branch only.
 *
 * A producer reads a file to describe a change, so a call the user was never
 * asked about must not pay for it. A producer that throws degrades to a stated
 * reason rather than to silence: `readPreparedPath` throws precisely when the
 * target changed identity since authorization, which is the case a reader most
 * needs to see.
 */
function producePreview(spec: PermissionSpec, params: unknown): PermissionPreview | undefined {
	if (!spec.previewCall) return undefined;
	try {
		return spec.previewCall(params as never);
	} catch (error) {
		return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
}

function describeDecline(toolName: string, guidance: string | undefined): string {
	const trimmed = guidance?.trim().slice(0, MAX_GUIDANCE_CHARS);
	if (!trimmed) return `${toolName} was declined.`;
	return `${toolName} was declined. The user asked for this instead. ${trimmed}`;
}

/** Pure decision function, independent of the beforeToolCall adapter shape below — the part under direct test. */
export async function evaluateToolCall(
	toolName: string,
	params: unknown,
	options: PermissionGateOptions,
): Promise<GateDecision> {
	const contract = resolveToolContract(options.getContract, toolName);
	const spec = contract.permission;
	if (spec.prepareCall) spec.prepareCall(params as never);
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
		preview: producePreview(spec, params),
		toolName,
		description: ruleForCall !== null ? spec.describe(ruleForCall) : `Run ${toolName}`,
		// Only offer a session grant the persist branch below would actually write.
		sessionScope: ruleForCall !== null ? { description: spec.describe(ruleForCall) } : undefined,
	});
	if (!answer.allow) {
		return { block: true, reason: describeDecline(toolName, answer.guidance) };
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
