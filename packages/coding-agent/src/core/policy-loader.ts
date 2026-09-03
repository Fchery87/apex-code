/**
 * VF.2: the ONE projection from policy settings to runtime policies (spec
 * 2026-09-01-configured-verification-and-formatting.md § 1; ADR 0028; ADR
 * 0010's one-projection rule applied to configured commands). Nothing else
 * in the codebase re-derives defaults, bounds, or trust stamps — surfaces
 * consume `loadPolicyConfiguration()` output, and the executor (VF.3)
 * consumes these policies verbatim.
 *
 * Strictness contract: any validation error inside a source drops that
 * entire source and surfaces structured errors. Half-applied policies are
 * worse than absent ones because they look configured while running under
 * different bounds than the user wrote. A missing `policies` key stays
 * inert: no policies, no errors, no runtime.
 */

/** Hard bounds. Caps exist so a typo cannot configure an unbounded run. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 262_144; // 256 KiB
export const MAX_MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB
export const DEFAULT_MAX_OUTPUT_LINES = 2_000;
export const MAX_MAX_OUTPUT_LINES = 10_000;

/** Capability names from the shared tool-contract vocabulary (ADR 0010). */
export type PolicyCapability = "exec" | "fs.write";
export type PolicyPermission = "allow" | "ask" | "deny";
export type PolicySource = "user" | "project";

export interface CommandPolicy {
	id: string;
	executable: string;
	argv: string[];
	cwd: "workspace" | string;
	pathScope?: string[];
	timeoutMs: number;
	maxOutputBytes: number;
	maxOutputLines: number;
	shell: false;
	permission: PolicyPermission;
	trustedSource: PolicySource;
}

export interface VerificationPolicy extends CommandPolicy {
	kind: "verification";
	blocksCompletion: boolean;
}

export interface FormatterPolicy extends CommandPolicy {
	kind: "formatter";
	mutatesFiles: true;
	declaredPaths: string[];
}

type StampedPolicy = VerificationPolicy | FormatterPolicy;

export interface PolicyLoadError {
	source: PolicySource;
	/** Policy ID when the error is attributable to one entry. */
	policyId?: string;
	message: string;
}

export interface PolicySnapshot {
	verification: VerificationPolicy[];
	formatter: FormatterPolicy[];
	errors: PolicyLoadError[];
}

export interface PolicyConfigurationInput {
	globalSettings?: unknown;
	projectSettings?: unknown;
	projectTrusted: boolean;
}

interface RawPolicyEntry extends Record<string, unknown> {
	id?: unknown;
	executable?: unknown;
	argv?: unknown;
	cwd?: unknown;
	pathScope?: unknown;
	timeoutMs?: unknown;
	maxOutputBytes?: unknown;
	maxOutputLines?: unknown;
	shell?: unknown;
	permission?: unknown;
}

const KNOWN_BASE_FIELDS = new Set([
	"id",
	"executable",
	"argv",
	"cwd",
	"pathScope",
	"timeoutMs",
	"maxOutputBytes",
	"maxOutputLines",
	"shell",
	"permission",
]);

function hasTraversalSegment(path: string): boolean {
	return path.split("/").includes("..");
}

/**
 * Validate one raw entry and stamp the canonical runtime shape. Returns
 * either the policy or an error message; the caller drops the source on any
 * error. Field-by-field so error messages name the offending field.
 */
function stampPolicy(
	source: PolicySource,
	kind: "verification" | "formatter",
	entry: RawPolicyEntry,
	seenIds: Set<string>,
): { policy?: StampedPolicy; error?: string; policyId?: string } {
	const policyId = typeof entry.id === "string" ? entry.id : undefined;
	const fail = (message: string): { error: string; policyId?: string } => ({ error: message, policyId });

	if (typeof entry.id !== "string" || entry.id.length === 0) {
		return fail("id must be a non-empty string");
	}
	if (seenIds.has(entry.id)) {
		return fail(`duplicate policy id "${entry.id}" within one source`);
	}
	if (typeof entry.executable !== "string" || entry.executable.length === 0) {
		return fail("executable must be a non-empty string");
	}
	if (!Array.isArray(entry.argv) || entry.argv.length === 0 || entry.argv.some((part) => typeof part !== "string")) {
		return fail("argv must be a non-empty array of strings");
	}
	if (entry.shell !== undefined && entry.shell !== false) {
		return fail("shell must be literal false; shell execution is not a supported policy configuration");
	}
	if (entry.cwd !== undefined) {
		if (typeof entry.cwd !== "string" || entry.cwd.length === 0) {
			return fail('cwd must be the literal "workspace" or a non-empty workspace-relative path');
		}
		if (entry.cwd !== "workspace" && (entry.cwd.startsWith("/") || hasTraversalSegment(entry.cwd))) {
			return fail('cwd must stay inside the workspace: no absolute paths, no ".." segments');
		}
	}
	if (entry.pathScope !== undefined) {
		if (
			!Array.isArray(entry.pathScope) ||
			entry.pathScope.length === 0 ||
			entry.pathScope.some((part) => typeof part !== "string" || part.length === 0 || hasTraversalSegment(part))
		) {
			return fail('pathScope must be non-empty workspace-relative patterns without ".." segments');
		}
	}

	const timeoutMs = (entry.timeoutMs ?? DEFAULT_TIMEOUT_MS) as number;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
		return fail(`timeoutMs must be a positive integer no greater than ${MAX_TIMEOUT_MS}`);
	}
	const maxOutputBytes = (entry.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES) as number;
	if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_MAX_OUTPUT_BYTES) {
		return fail(`maxOutputBytes must be a positive integer no greater than ${MAX_MAX_OUTPUT_BYTES}`);
	}
	const maxOutputLines = (entry.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES) as number;
	if (!Number.isInteger(maxOutputLines) || maxOutputLines <= 0 || maxOutputLines > MAX_MAX_OUTPUT_LINES) {
		return fail(`maxOutputLines must be a positive integer no greater than ${MAX_MAX_OUTPUT_LINES}`);
	}

	const permission = (entry.permission ?? "ask") as PolicyPermission;
	if (permission !== "allow" && permission !== "ask" && permission !== "deny") {
		return fail('permission must be "allow", "ask", or "deny"');
	}

	for (const field of Object.keys(entry)) {
		if (
			!KNOWN_BASE_FIELDS.has(field) &&
			!(kind === "verification" && field === "blocksCompletion") &&
			!(kind === "formatter" && field === "declaredPaths")
		) {
			return fail(`unknown policy field "${field}"`);
		}
	}

	const base: Omit<CommandPolicy, "trustedSource"> & { trustedSource: PolicySource } = {
		id: entry.id,
		executable: entry.executable,
		argv: entry.argv as string[],
		cwd: (entry.cwd as string | undefined) ?? "workspace",
		...(entry.pathScope !== undefined ? { pathScope: entry.pathScope as string[] } : {}),
		timeoutMs,
		maxOutputBytes,
		maxOutputLines,
		shell: false,
		permission,
		trustedSource: source,
	};

	if (kind === "verification") {
		if (entry.blocksCompletion !== undefined && typeof entry.blocksCompletion !== "boolean") {
			return fail("blocksCompletion must be a boolean");
		}
		return { policy: { ...base, kind, blocksCompletion: (entry.blocksCompletion as boolean | undefined) ?? false } };
	}

	if (!Array.isArray(entry.declaredPaths) || entry.declaredPaths.length === 0) {
		return fail("declaredPaths is required for formatter policies and must be a non-empty array");
	}
	if (entry.declaredPaths.some((part) => typeof part !== "string" || part.length === 0 || hasTraversalSegment(part))) {
		return fail('declaredPaths must be non-empty workspace-relative patterns without ".." segments');
	}
	return { policy: { ...base, kind, mutatesFiles: true, declaredPaths: entry.declaredPaths as string[] } };
}

/**
 * Load one source. Returns the stamped policies plus errors; on ANY error
 * the source contributes nothing (fail closed, all-or-nothing per source).
 */
function loadSource(source: PolicySource, raw: unknown, errors: PolicyLoadError[]): StampedPolicy[] {
	if (raw === undefined || raw === null) {
		return [];
	}
	const fail = (message: string, policyId?: string): [] => {
		errors.push({ source, policyId, message });
		return [];
	};
	if (typeof raw !== "object") {
		return fail("policies must be an object");
	}
	const policies = raw as Record<string, unknown>;
	if (policies.schemaVersion !== 1) {
		return fail(`unsupported policies schemaVersion ${JSON.stringify(policies.schemaVersion)}`);
	}

	const seenIds = new Set<string>();
	const stamped: StampedPolicy[] = [];
	for (const kind of ["verification", "formatter"] as const) {
		const entries = policies[kind];
		if (entries === undefined) {
			continue;
		}
		if (!Array.isArray(entries)) {
			return fail(`policies.${kind} must be an array`);
		}
		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null) {
				return fail(`policies.${kind} contains a non-object entry`);
			}
			const result = stampPolicy(source, kind, entry as RawPolicyEntry, seenIds);
			if (result.error !== undefined || result.policy === undefined) {
				return fail(result.error ?? "policy failed to stamp", result.policyId);
			}
			seenIds.add(result.policy.id);
			stamped.push(result.policy);
		}
	}
	return stamped;
}

/**
 * Project raw per-source policy settings onto the canonical snapshot. The
 * project source participates only when the project is trusted (ADR 0028);
 * within a trusted project a project policy ID replaces the user policy
 * with the same ID. This function never throws and never reads ambient
 * state: identical inputs project identical snapshots.
 */
export function loadPolicyConfiguration(input: PolicyConfigurationInput): PolicySnapshot {
	const errors: PolicyLoadError[] = [];
	const userPolicies = loadSource("user", input.globalSettings, errors);
	const projectPolicies = input.projectTrusted ? loadSource("project", input.projectSettings, errors) : [];

	const verification: VerificationPolicy[] = [];
	const formatter: FormatterPolicy[] = [];
	const byId = new Map<string, StampedPolicy>();
	for (const policy of [...userPolicies, ...projectPolicies]) {
		byId.set(policy.id, policy);
	}
	for (const policy of byId.values()) {
		if (policy.kind === "verification") {
			verification.push(policy);
		} else {
			formatter.push(policy as FormatterPolicy);
		}
	}
	return { verification, formatter, errors };
}
