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
