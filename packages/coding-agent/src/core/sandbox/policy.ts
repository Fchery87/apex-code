import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface SandboxPolicy {
	/**
	 * The one directory the session is anchored to. State, sessions, and the concurrency
	 * lease all live under it, and the child starts here, so it stays singular even when
	 * more roots are writable.
	 */
	readonly workspace: string;
	readonly allowedHosts: readonly string[];
	/** Further writable directories, named on the command line and validated the same way. */
	readonly additionalWritableRoots: readonly string[];
}

export type SandboxPolicyResult =
	| { readonly kind: "valid"; readonly policy: SandboxPolicy }
	| { readonly kind: "invalid"; readonly reason: string };

export type SandboxStatus = { readonly kind: "enforced" } | { readonly kind: "unavailable"; readonly reason: string };

export class SandboxUnavailableError extends Error {
	constructor(reason: string) {
		super(`OS sandbox is not enforcing this agent session: ${reason}`);
		this.name = "SandboxUnavailableError";
	}
}

/**
 * Validate the single writable boundary before any platform backend runs. We accept
 * no relative, missing, or non-directory workspace because a backend must never
 * silently broaden an ambiguous path into host authority.
 */
export function createSandboxPolicy(options: {
	workspace: string;
	allowedHosts?: readonly string[];
	additionalWritableRoots?: readonly string[];
}): SandboxPolicyResult {
	const workspace = validateRoot(options.workspace, "workspace");
	if (typeof workspace !== "string") return workspace;

	const additionalWritableRoots: string[] = [];
	for (const candidate of options.additionalWritableRoots ?? []) {
		const resolved = validateRoot(candidate, "writable root");
		if (typeof resolved !== "string") return resolved;
		additionalWritableRoots.push(resolved);
	}

	return {
		kind: "valid",
		policy: { workspace, allowedHosts: options.allowedHosts ?? [], additionalWritableRoots },
	};
}

/**
 * Resolve one writable root, or explain why it cannot be one.
 *
 * Every root goes through the same check for the same reason the workspace always did: a
 * backend must never silently broaden an ambiguous path into host authority, and an extra
 * root named on the command line is no less capable of doing that than the first one.
 */
function validateRoot(candidate: string, label: string): string | { kind: "invalid"; reason: string } {
	if (!isAbsolute(candidate)) {
		return { kind: "invalid", reason: `Sandbox ${label} must be an absolute path: ${candidate}` };
	}
	if (!existsSync(candidate)) {
		return { kind: "invalid", reason: `Sandbox ${label} does not exist: ${candidate}` };
	}
	if (!statSync(candidate).isDirectory()) {
		return { kind: "invalid", reason: `Sandbox ${label} is not a directory: ${candidate}` };
	}
	return realpathSync(candidate);
}

/** Throws rather than returning an executable fallback when OS enforcement is absent. */
export function requireSandboxEnforcement(status: SandboxStatus): void {
	if (status.kind === "enforced") return;
	throw new SandboxUnavailableError(status.reason);
}
