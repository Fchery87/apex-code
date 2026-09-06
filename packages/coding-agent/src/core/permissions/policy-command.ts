/**
 * PS.1: the permission authority for configured commands (verification and
 * formatter policies from the VF.2 loader). Tool calls reach the gate through
 * `evaluateToolCall`; a configured command has no tool name and no rule
 * grammar, so it cannot use that path. This is the second entry point to the
 * *same* authority, not a second authority: it reuses `resolveWithMode`, so
 * plan mode's `exec`/`fs.write` floor and the bypass escape hatch behave
 * identically for a formatter and for the write tool.
 *
 * Two differences from `evaluateToolCall` are deliberate. A `deny` policy is
 * refused before any mode is consulted, because the policy permission is the
 * configuration author's ceiling and `bypassPermissions` must not raise it.
 * And an approved `ask` never persists a rule, because there is no tool name to
 * persist it against.
 */

import type { PolicyPermission } from "../policy-loader.ts";
import type { Capability } from "../tools/contract.ts";
import type { GateDecision } from "./gate.ts";
import { resolveWithMode } from "./modes.ts";
import type { PermissionResponder } from "./responder.ts";
import type { PermissionMode } from "./store.ts";

/** The typed facts a configured command presents for authorization. */
export interface ConfiguredCommandOperation {
	policyId: string;
	executable: string;
	argv: readonly string[];
	cwd: string;
	/** Declared write patterns already intersected with the policy's pathScope, or undefined for a non-mutating command. */
	writeScope: readonly string[] | undefined;
	capabilities: ReadonlySet<Capability>;
	permission: PolicyPermission;
}

export interface ConfiguredCommandAuthorizationOptions {
	getMode: () => PermissionMode | Promise<PermissionMode>;
	/** Absent in a non-interactive session: an `ask` policy then fails closed. */
	responder?: PermissionResponder;
	/** Resolves a responder at call time because the interactive UI binds after session construction. */
	getResponder?: () => PermissionResponder | undefined;
}

/** Injected into the verification tracker and the formatter runner so neither imports the gate. */
export type AuthorizeConfiguredCommand = (operation: ConfiguredCommandOperation) => Promise<GateDecision>;

function describe(operation: ConfiguredCommandOperation): string {
	return [operation.executable, ...operation.argv].join(" ");
}

export async function authorizeConfiguredCommand(
	operation: ConfiguredCommandOperation,
	options: ConfiguredCommandAuthorizationOptions,
): Promise<GateDecision> {
	if (operation.permission === "deny") {
		return { block: true, reason: `Policy ${operation.policyId} is configured with permission "deny".` };
	}

	const base = operation.permission === "allow" ? "allow" : "ask";
	const resolution = resolveWithMode(await options.getMode(), { behavior: base }, operation.capabilities);

	if (resolution.behavior === "allow") return { block: false };
	if (resolution.behavior === "deny") {
		return { block: true, reason: `Policy ${operation.policyId} is not permitted in the current permission mode.` };
	}

	const responder = options.getResponder?.() ?? options.responder;
	if (!responder) {
		return {
			block: true,
			reason: `Policy ${operation.policyId} requires approval, and no responder is available in this session.`,
		};
	}
	const answer = await responder.ask({ toolName: operation.policyId, description: describe(operation) });
	if (!answer.allow) {
		return { block: true, reason: `Policy ${operation.policyId} was declined.` };
	}
	return { block: false };
}
