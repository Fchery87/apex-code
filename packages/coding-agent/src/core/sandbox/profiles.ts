import { SettingsManager } from "../settings-manager.ts";

/**
 * A named, saved combination of what the OS boundary permits.
 *
 * Apex already has a permission rule model with five modes and eight-source precedence
 * (ADR 0004). That governs the tool gate at `beforeToolCall`, inside the child. This
 * governs the supervisor's launch contract, outside it. They are deliberately separate
 * surfaces, and conflating them is exactly the misreading that makes `bypassPermissions`
 * look like a sandbox escape -- so a profile here carries only boundary inputs and has no
 * way to express a tool-gate mode.
 *
 * It also has no way to express "no boundary". That decision stays on the command line
 * where a human has to type it, per ADR 0005's 2026-08-28 amendment; a profile can widen
 * what is reachable and writable, never remove the boundary that constrains them.
 *
 * Resolved from global settings only, with `projectTrusted: false`, for the reason ADR
 * 0016 gives for every supervisor policy input: a repository that could define the
 * boundary it runs under would be granting itself authority.
 */
export interface SandboxProfile {
	readonly allowedHosts: readonly string[];
	readonly additionalWritableRoots: readonly string[];
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Resolve one named profile, or undefined when the name is absent or was never given. */
export function resolveSandboxProfile(
	name: string | undefined,
	cwd: string,
	agentDir: string,
): SandboxProfile | undefined {
	if (!name) return undefined;
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const profiles = settings.getSandboxProfiles();
	const profile = profiles?.[name];
	if (!profile || typeof profile !== "object") return undefined;
	const record = profile as Record<string, unknown>;
	// Only these two keys are read. An unknown key in a profile is ignored rather than
	// rejected, so a profile written for a later version does not break this one, and a
	// key this version does not understand can never take effect by accident.
	return {
		allowedHosts: stringArray(record.allowedHosts),
		additionalWritableRoots: stringArray(record.additionalWritableRoots),
	};
}
