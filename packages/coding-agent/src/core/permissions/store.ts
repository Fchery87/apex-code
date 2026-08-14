/**
 * Persistence for the permission rule model (ADR 0004). Four of the eight sources
 * are file-backed (policy, local, project, user); the other four are runtime-only
 * (flag, cliArg — parsed once from argv, not stored here; command, session — held
 * in memory for the life of the process). `session`-source updates are never
 * written to disk: "allow for this session" dies with the session by design.
 *
 * Reuses the locked-JSON-file backend already proven for Phase 1's operational
 * state (FileAuthStorageBackend) rather than widening `SettingsScope`, which only
 * covers two of these four file-backed sources and represents a different, larger
 * settings domain.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../auth-storage.ts";
import type { PermissionBehavior } from "../tools/contract.ts";
import type { PermissionRule, PermissionSource } from "./rules.ts";

export const PERMISSION_MODES = ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** Sources a PermissionUpdate may target. Excludes `policy` (administrator-managed,
 * never user-writable) and `flag`/`cliArg` (parsed once from argv at startup, not
 * something this store updates after the fact). */
export const WRITABLE_PERMISSION_SOURCES = ["local", "project", "user", "command", "session"] as const;
export type WritablePermissionSource = (typeof WRITABLE_PERMISSION_SOURCES)[number];

const FILE_BACKED_SOURCES = ["local", "project", "user"] as const;
type FileBackedSource = (typeof FILE_BACKED_SOURCES)[number];

const RUNTIME_SOURCES = ["command", "session"] as const;
type RuntimeSource = (typeof RUNTIME_SOURCES)[number];

/** A rule as persisted: `source` is never stored — it is implied by which file it came from. */
export type StoredPermissionRule = Omit<PermissionRule, "source">;

export interface RuleMatcher {
	toolName: string;
	ruleContent?: string;
}

export type PermissionUpdate =
	| { type: "addRules"; destination: WritablePermissionSource; rules: readonly StoredPermissionRule[] }
	| { type: "replaceRules"; destination: WritablePermissionSource; rules: readonly StoredPermissionRule[] }
	| { type: "removeRules"; destination: WritablePermissionSource; matching: readonly RuleMatcher[] }
	| { type: "setMode"; destination: WritablePermissionSource; mode: PermissionMode };

export interface PermissionStoreError {
	source: PermissionSource;
	error: Error;
}

export interface PermissionStoreSnapshot {
	rules: readonly PermissionRule[];
	modesBySource: ReadonlyMap<WritablePermissionSource, PermissionMode>;
	errors: readonly PermissionStoreError[];
}

export interface PermissionRuleStore {
	snapshot(): Promise<PermissionStoreSnapshot>;
	apply(update: PermissionUpdate): Promise<void>;
}

const STORE_VERSION = 1;

interface StoredPermissionScope {
	version: number;
	rules: StoredPermissionRule[];
	mode?: PermissionMode;
}

function emptyScope(): StoredPermissionScope {
	return { version: STORE_VERSION, rules: [] };
}

function isPermissionBehavior(value: unknown): value is PermissionBehavior {
	return value === "allow" || value === "deny" || value === "ask";
}

function parseScope(content: string | undefined): StoredPermissionScope {
	if (!content) return emptyScope();
	const parsed = JSON.parse(content);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Invalid permission rules file: unexpected shape");
	}
	// FileAuthStorageBackend (shared with auth.json) seeds a freshly created file
	// with the literal text "{}". Treat a content-free object as "nothing written
	// yet" rather than malformed; a real malformed file has some recognizable but
	// wrong-shaped field, caught below.
	if (!("version" in parsed) && !("rules" in parsed) && !("mode" in parsed)) {
		return emptyScope();
	}
	if (
		parsed.version !== STORE_VERSION ||
		(parsed.mode !== undefined && !(PERMISSION_MODES as readonly string[]).includes(parsed.mode)) ||
		!Array.isArray(parsed.rules) ||
		!parsed.rules.every(
			(rule: unknown) =>
				typeof rule === "object" &&
				rule !== null &&
				typeof (rule as StoredPermissionRule).toolName === "string" &&
				isPermissionBehavior((rule as StoredPermissionRule).behavior) &&
				((rule as StoredPermissionRule).ruleContent === undefined ||
					typeof (rule as StoredPermissionRule).ruleContent === "string"),
		)
	) {
		throw new Error("Invalid permission rules file: unexpected shape");
	}
	return parsed as StoredPermissionScope;
}

function applyToScope(scope: StoredPermissionScope, update: PermissionUpdate): StoredPermissionScope {
	switch (update.type) {
		case "addRules":
			return { ...scope, rules: [...scope.rules, ...update.rules] };
		case "replaceRules":
			return { ...scope, rules: [...update.rules] };
		case "removeRules":
			return {
				...scope,
				rules: scope.rules.filter(
					(rule) =>
						!update.matching.some((m) => m.toolName === rule.toolName && m.ruleContent === rule.ruleContent),
				),
			};
		case "setMode":
			return { ...scope, mode: update.mode };
	}
}

function defaultPolicyPath(): string {
	if (process.env.APEX_CODE_POLICY_PATH) return process.env.APEX_CODE_POLICY_PATH;
	return process.platform === "win32"
		? join(process.env.ProgramData ?? "C:\\ProgramData", "apex-code", "policy.json")
		: "/etc/apex-code/policy.json";
}

export interface CreateFilePermissionRuleStoreOptions {
	cwd: string;
	agentDir?: string;
	/** Overrides the managed policy file path. Defaults to $APEX_CODE_POLICY_PATH, else an OS-specific system location. */
	policyPath?: string;
	/** Test seam: inject backends for the three writable file-backed sources instead of touching real files. */
	backends?: Partial<Record<FileBackedSource, AuthStorageBackend>>;
	/** Immutable argv layers (`flag` / `cliArg`), validated by the CLI before construction. */
	initialRules?: readonly PermissionRule[];
}

/** File-backed store for policy/local/project/user, in-memory for command/session. */
export class FilePermissionRuleStore implements PermissionRuleStore {
	private readonly backends: Record<FileBackedSource, AuthStorageBackend>;
	private readonly policyPath: string;
	private readonly initialRules: readonly PermissionRule[];
	private readonly runtimeRules: Record<RuntimeSource, StoredPermissionRule[]> = { command: [], session: [] };
	private readonly runtimeModes: Partial<Record<RuntimeSource, PermissionMode>> = {};

	constructor(options: CreateFilePermissionRuleStoreOptions) {
		const agentDir = options.agentDir ?? getAgentDir();
		const cwd = resolvePath(options.cwd);
		this.backends = {
			user: new FileAuthStorageBackend(join(agentDir, "permissions.json")),
			project: new FileAuthStorageBackend(join(cwd, ".apex-code", "permissions.json")),
			local: new FileAuthStorageBackend(join(cwd, ".apex-code", "permissions.local.json")),
			...options.backends,
		};
		this.policyPath = options.policyPath ?? defaultPolicyPath();
		this.initialRules = options.initialRules ?? [];
	}

	private async readFileBackedScope(
		source: FileBackedSource,
	): Promise<{ scope: StoredPermissionScope; error?: Error }> {
		try {
			let content: string | undefined;
			await this.backends[source].withLockAsync(async (current) => {
				content = current;
				return { result: undefined };
			});
			return { scope: parseScope(content) };
		} catch (error) {
			return { scope: emptyScope(), error: error instanceof Error ? error : new Error(String(error)) };
		}
	}

	private async readPolicy(): Promise<{ scope: StoredPermissionScope; error?: Error }> {
		try {
			const content = await readFile(this.policyPath, "utf-8");
			return { scope: parseScope(content) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { scope: emptyScope() };
			return { scope: emptyScope(), error: error instanceof Error ? error : new Error(String(error)) };
		}
	}

	async snapshot(): Promise<PermissionStoreSnapshot> {
		const [policy, local, project, user] = await Promise.all([
			this.readPolicy(),
			this.readFileBackedScope("local"),
			this.readFileBackedScope("project"),
			this.readFileBackedScope("user"),
		]);
		const errors: PermissionStoreError[] = [];
		const withSource = (
			source: PermissionSource,
			entry: { scope: StoredPermissionScope; error?: Error },
		): PermissionRule[] => {
			if (entry.error) errors.push({ source, error: entry.error });
			return entry.scope.rules.map((rule) => ({ ...rule, source }));
		};

		const rules: PermissionRule[] = [
			...withSource("policy", policy),
			...this.initialRules,
			...withSource("local", local),
			...withSource("project", project),
			...withSource("user", user),
			...this.runtimeRules.command.map((rule) => ({ ...rule, source: "command" as const })),
			...this.runtimeRules.session.map((rule) => ({ ...rule, source: "session" as const })),
		];

		const modesBySource = new Map<WritablePermissionSource, PermissionMode>();
		if (local.scope.mode) modesBySource.set("local", local.scope.mode);
		if (project.scope.mode) modesBySource.set("project", project.scope.mode);
		if (user.scope.mode) modesBySource.set("user", user.scope.mode);
		if (this.runtimeModes.command) modesBySource.set("command", this.runtimeModes.command);
		if (this.runtimeModes.session) modesBySource.set("session", this.runtimeModes.session);

		return { rules, modesBySource, errors };
	}

	async apply(update: PermissionUpdate): Promise<void> {
		if (update.destination === "command" || update.destination === "session") {
			this.applyRuntime(update.destination, update);
			return;
		}
		await this.backends[update.destination].withLockAsync(async (content) => {
			const next = applyToScope(parseScope(content), update);
			return { result: undefined, next: JSON.stringify(next, null, 2) };
		});
	}

	private applyRuntime(destination: RuntimeSource, update: PermissionUpdate): void {
		if (update.type === "setMode") {
			this.runtimeModes[destination] = update.mode;
			return;
		}
		const current: StoredPermissionScope = { version: STORE_VERSION, rules: this.runtimeRules[destination] };
		this.runtimeRules[destination] = applyToScope(current, update).rules;
	}
}

export interface DerivedPermissionRuleStoreOptions {
	/** The parent's live store. Read fresh on every `snapshot()`, never cached, so a
	 * rule the parent picks up mid-session (e.g. a human's "always allow") is visible
	 * to the child on its very next call. */
	parent: PermissionRuleStore;
}

/**
 * A delegated child's permission store (roadmap Phase 5, ADR 0008). A read-through
 * view over the parent's live snapshot -- including its runtime-only sources
 * (`flag`, `cliArg`, `command`, `session`), which a subprocess-spawned child could
 * never observe -- plus a child-local runtime overlay for the child's own writes.
 *
 * `apply()` never reaches the parent. It writes only into this instance's own
 * overlay, and only for the two runtime-only writable sources (`command`, `session`);
 * a file-backed destination (`local`, `project`, `user`) is rejected outright, not
 * silently redirected -- a delegated child must never be able to persist to the
 * parent's settings files, and "runtime-only" is enforced by construction here, not
 * by a convention a future caller could forget. The overlay is discarded with the
 * child: there is no code path from a child's approval back into the parent's store,
 * which is what keeps a child's `persist: true` from widening its parent.
 */
export class DerivedPermissionRuleStore implements PermissionRuleStore {
	private readonly parent: PermissionRuleStore;
	private readonly overlayRules: Record<RuntimeSource, StoredPermissionRule[]> = { command: [], session: [] };
	private readonly overlayModes: Partial<Record<RuntimeSource, PermissionMode>> = {};

	constructor(options: DerivedPermissionRuleStoreOptions) {
		this.parent = options.parent;
	}

	async snapshot(): Promise<PermissionStoreSnapshot> {
		const parentSnapshot = await this.parent.snapshot();
		const rules: PermissionRule[] = [
			...parentSnapshot.rules,
			...this.overlayRules.command.map((rule) => ({ ...rule, source: "command" as const })),
			...this.overlayRules.session.map((rule) => ({ ...rule, source: "session" as const })),
		];
		const modesBySource = new Map(parentSnapshot.modesBySource);
		if (this.overlayModes.command !== undefined) modesBySource.set("command", this.overlayModes.command);
		if (this.overlayModes.session !== undefined) modesBySource.set("session", this.overlayModes.session);
		return { rules, modesBySource, errors: parentSnapshot.errors };
	}

	async apply(update: PermissionUpdate): Promise<void> {
		if (update.destination !== "command" && update.destination !== "session") {
			throw new Error(
				`A delegated child cannot persist permission rules to "${update.destination}" -- only "command" and "session" are writable from a derived store (ADR 0008).`,
			);
		}
		if (update.type === "setMode") {
			this.overlayModes[update.destination] = update.mode;
			return;
		}
		const current: StoredPermissionScope = {
			version: STORE_VERSION,
			rules: this.overlayRules[update.destination],
		};
		this.overlayRules[update.destination] = applyToScope(current, update).rules;
	}
}
