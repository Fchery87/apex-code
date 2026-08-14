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

/**
 * Plan mode's hard floor. `state` is deliberately excluded: an explicit harness-state
 * tool such as `todo_write` is how plan mode maintains the plan it is presenting, so
 * denying it outright would make plan mode unable to do its own job (spec
 * `2026-08-13-tool-surface.md`, "The problem" item 4).
 */
const PLAN_MODE_DENIED_CAPABILITIES: readonly Capability[] = ["fs.write", "exec", "delegate"];

function isPlanModeDenied(capabilities: ReadonlySet<Capability>): boolean {
	return PLAN_MODE_DENIED_CAPABILITIES.some((capability) => capabilities.has(capability));
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
	// Plan mode is a hard mutating safety floor. Managed policy is otherwise
	// explicitly non-overridable (ADR 0004); bypass remains an escape hatch only
	// for lower-precedence sources.
	if (mode === "plan" && isPlanModeDenied(capabilities)) {
		return { behavior: "deny" };
	}
	if (ruleResolution.rule?.source === "policy") {
		return ruleResolution;
	}
	if (mode === "bypassPermissions") {
		return { behavior: "allow" };
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
