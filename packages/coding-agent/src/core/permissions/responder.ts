/** Interactive escalation for an `ask`-resolved permission decision. */

/**
 * What the prompt shows about the change it is authorizing.
 *
 * `unavailable` is a first-class variant rather than an absent field, because a
 * reader who is shown nothing cannot tell "this changes nothing" from "we could
 * not read it". Only the second one should stop them approving.
 */
export type PermissionPreview =
	| { kind: "diff"; path: string; lines: readonly string[]; omittedLines: number }
	| { kind: "summary"; lines: readonly string[] }
	| { kind: "unavailable"; reason: string };

export interface PermissionAskRequest {
	toolName: string;
	/** Human-readable rendering of what would be persisted, from the tool's own describe(). */
	description: string;
	/**
	 * Present only when the tool's `ruleForCall()` yields something to persist.
	 *
	 * The gate silently ignores `persist` when there is no rule, so offering the
	 * choice in that case promised a grant nothing would write.
	 */
	sessionScope?: { description: string };
	/**
	 * Produced by the tool's `previewCall`, after the gate decides to ask and never
	 * before. Absent when the tool declares no producer.
	 */
	preview?: PermissionPreview;
}

export interface PermissionAnswer {
	allow: boolean;
	/** Persist a session-source rule via the tool's own ruleForCall(). The grant ends with the session. */
	persist?: boolean;
	/**
	 * On a denial, what the user wants done instead. The gate bounds it and carries
	 * it in `GateDecision.reason`, which the agent loop already turns into the
	 * blocked tool result, so no second message queue is involved.
	 */
	guidance?: string;
}

export interface PermissionResponder {
	ask(request: PermissionAskRequest): Promise<PermissionAnswer>;
}

const ALLOW_ONCE = "Allow once";
/** Named for what the gate actually writes: an `addRules` update whose destination is "session". */
const ALLOW_SESSION = "Allow for this session";
const REJECT_WITH_GUIDANCE = "Reject and say what to do instead";
const DENY = "Deny";

/** The subset of ExtensionUIContext (core/extensions/types.ts) this responder needs. */
export interface SelectUI {
	select(title: string, options: string[], opts?: { preview?: PermissionPreview }): Promise<string | undefined>;
	/** Absent on hosts that cannot collect free text; the guidance choice is then not offered. */
	input?(title: string, placeholder?: string): Promise<string | undefined>;
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
		async ask({ toolName, description, sessionScope, preview }) {
			const options = [ALLOW_ONCE];
			if (sessionScope) options.push(ALLOW_SESSION);
			if (ui.input) options.push(REJECT_WITH_GUIDANCE);
			options.push(DENY);

			// The preview travels as data. Drawing it belongs to whatever is hosting
			// the prompt, which keeps this file free of a rendering dependency.
			const choice = await ui.select(
				`Permission required — ${toolName}: ${description}`,
				options,
				preview ? { preview } : undefined,
			);
			if (choice === ALLOW_ONCE) return { allow: true };
			if (choice === ALLOW_SESSION) return { allow: true, persist: true };
			if (choice === REJECT_WITH_GUIDANCE && ui.input) {
				const guidance = await ui.input(`What should Apex do instead of ${toolName}?`);
				// A dismissed guidance prompt is still a denial. Failing closed here
				// matches every other path out of this function.
				return guidance?.trim() ? { allow: false, guidance: guidance.trim() } : { allow: false };
			}
			// DENY, or no selection (cancelled/dismissed) — fail closed.
			return { allow: false };
		},
	};
}
