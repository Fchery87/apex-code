/** Interactive escalation for an `ask`-resolved permission decision. */

export interface PermissionAskRequest {
	toolName: string;
	/** Human-readable rendering of what would be persisted, from the tool's own describe(). */
	description: string;
}

export interface PermissionAnswer {
	allow: boolean;
	/** "Always allow this" — persist a session-source rule via the tool's own ruleForCall(). */
	persist?: boolean;
}

export interface PermissionResponder {
	ask(request: PermissionAskRequest): Promise<PermissionAnswer>;
}

const ALLOW_ONCE = "Allow once";
const ALWAYS_ALLOW = "Always allow";
const DENY = "Deny";

/** The subset of ExtensionUIContext (core/extensions/types.ts) this responder needs. */
export interface SelectUI {
	select(title: string, options: string[]): Promise<string | undefined>;
}

/**
 * Builds a PermissionResponder over the same live, mid-session prompt primitive
 * extensions already use (ExtensionUIContext.select) — no new rendering
 * dependency, per the roadmap's "Explicitly not building" a second TUI stack.
 *
 * Deliberately answers only `{allow, persist}`. It never constructs a rule string
 * itself: generating one from `ruleForCall()` and persisting it is the gate's job
 * (permissions/gate.ts), so the tool that owns the grammar is the only thing that
 * ever writes a rule (ADR 0010).
 */
export function createInteractiveResponder(ui: SelectUI): PermissionResponder {
	return {
		async ask({ toolName, description }) {
			const choice = await ui.select(`Permission required — ${toolName}: ${description}`, [
				ALLOW_ONCE,
				ALWAYS_ALLOW,
				DENY,
			]);
			if (choice === ALLOW_ONCE) return { allow: true };
			if (choice === ALWAYS_ALLOW) return { allow: true, persist: true };
			// DENY, or no selection (cancelled/dismissed) — fail closed.
			return { allow: false };
		},
	};
}
