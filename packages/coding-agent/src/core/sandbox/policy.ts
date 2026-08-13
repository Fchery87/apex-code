import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface SandboxPolicy {
	readonly workspace: string;
	readonly allowedHosts: readonly string[];
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
export function createSandboxPolicy(options: { workspace: string; allowedHosts?: readonly string[] }): SandboxPolicyResult {
	if (!isAbsolute(options.workspace)) {
		return { kind: "invalid", reason: "Sandbox workspace must be an absolute path." };
	}
	if (!existsSync(options.workspace)) {
		return { kind: "invalid", reason: `Sandbox workspace does not exist: ${options.workspace}` };
	}
	if (!statSync(options.workspace).isDirectory()) {
		return { kind: "invalid", reason: `Sandbox workspace is not a directory: ${options.workspace}` };
	}
	return {
		kind: "valid",
		policy: {
			workspace: realpathSync(options.workspace),
			allowedHosts: options.allowedHosts ?? [],
		},
	};
}

/** Throws rather than returning an executable fallback when OS enforcement is absent. */
export function requireSandboxEnforcement(status: SandboxStatus): void {
	if (status.kind === "enforced") return;
	throw new SandboxUnavailableError(status.reason);
}
