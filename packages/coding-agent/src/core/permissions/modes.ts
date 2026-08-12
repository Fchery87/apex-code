/**
 * Permission modes (roadmap Phase 2a). A mode is a resolution layer applied on top
 * of `resolvePermission()`'s rule-based result, driven entirely by a tool's
 * declared `capabilities` — never by tool name, so a mode behaves correctly for a
 * tool that does not exist yet.
 *
 * `plan` and `bypassPermissions` are absolute: they override even an explicit
 * matching rule, because that is their entire purpose (a hard safety floor, and an
 * explicit "trust everything" escape hatch, respectively). `acceptEdits` and
 * `dontAsk` are conveniences that only ever act on the *absence* of an explicit
 * rule — they change what a bare tool default resolves to, but never overrule a
 * rule the user actually set.
 */

import type { Capability } from "../tools/contract.ts";
import type { PermissionResolution } from "./rules.ts";
import type { PermissionMode } from "./store.ts";

const MUTATING_CAPABILITIES: readonly Capability[] = ["fs.write", "exec", "delegate", "state"];

function isMutating(capabilities: ReadonlySet<Capability>): boolean {
	return MUTATING_CAPABILITIES.some((capability) => capabilities.has(capability));
}

/** fs.write only, with no exec/net/delegate/state — the shape acceptEdits auto-allows. */
function isEditShaped(capabilities: ReadonlySet<Capability>): boolean {
	return (
		capabilities.has("fs.write") &&
		!capabilities.has("exec") &&
		!capabilities.has("net") &&
		!capabilities.has("delegate") &&
		!capabilities.has("state")
	);
}

export function resolveWithMode(
	mode: PermissionMode,
	ruleResolution: PermissionResolution,
	capabilities: ReadonlySet<Capability>,
): PermissionResolution {
	if (mode === "bypassPermissions") {
		return { behavior: "allow" };
	}
	if (mode === "plan" && isMutating(capabilities)) {
		return { behavior: "deny" };
	}
	if (ruleResolution.rule) {
		// An explicit matching rule is authoritative for every remaining mode.
		return ruleResolution;
	}
	if (mode === "dontAsk" && ruleResolution.behavior === "ask") {
		return { behavior: "deny" };
	}
	if (mode === "acceptEdits" && ruleResolution.behavior === "ask" && isEditShaped(capabilities)) {
		return { behavior: "allow" };
	}
	return ruleResolution;
}
