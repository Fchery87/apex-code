/**
 * The delegation runtime (roadmap Phase 5, ADR 0008, task 5.2). Consumes the
 * capability ceiling (ceiling.ts) and a derived permission store
 * (`../permissions/store.ts`'s `DerivedPermissionRuleStore`) to run a real child
 * agent whose authority can never exceed its parent's.
 *
 * Agent definitions and child-session construction are both injected rather than
 * built in here: production agent discovery lives in `core/delegation/agents.ts`
 * (markdown + frontmatter, parsed on lookup) and plugs in through the same
 * resolver interface a test fixture implements; child-session construction is
 * injected so this module stays free of
 * `AgentSession`/`createAgentSession` and therefore free of the import cycle that
 * would create (`sdk.ts` already imports `agent-session.ts`).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentRunBudgetUsage } from "apex-code-agent-core";
import { type FileEntry, loadEntriesFromFile, type SessionEntry } from "../session-manager.ts";
import type { Capability } from "../tools/contract.ts";
import { computeCapabilityCeiling } from "./ceiling.ts";

/** A delegatable agent's static configuration. Markdown + frontmatter in production (`agents.ts`); a plain object in tests. */
export interface AgentDefinition {
	name: string;
	description: string;
	/** Tool names this agent may use. Never trusted directly -- the runtime derives the actual child tool list from the computed capability set, not from this list verbatim. */
	tools: string[];
	/** Optional model id. Falls back to the parent's current model when unset or unresolvable. */
	model?: string;
	systemPrompt: string;
}

/** Resolve an agent type to its definition, or `undefined` if unknown. Production implements this over markdown/frontmatter (`agents.ts`); tests inject plain functions with the same shape. */
export type AgentDefinitionResolver = (agentType: string) => AgentDefinition | undefined;

/** A running or completed child, as far as the runtime needs to know. */
export type ChildSessionStatus = "idle" | "running" | "interrupted" | "closed";

/** Terminal outcome of a child's latest settled turn. */
export type ChildTurnOutcome = "completed" | "failed" | "interrupted";

/**
 * Token and cost totals for one child run, rolled up from the child's OWN
 * session transcript (the session-file reading seam; never a second transcript
 * cache). The numbers are summed exactly as the provider reported them -- cost
 * is provider-reported, so cache reads are NOT re-priced, re-counted, or
 * double-counted; an entry without usage counts as zero.
 */
export interface ChildRunUsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	/** Wall-clock time (ms) the rollup was computed at. */
	asOf: number;
	/** Usage-bearing transcript entries examined (assistant messages, compaction, branch summaries), including those without usage. */
	entriesCounted: number;
}

/** The output and terminal outcome of a child's latest settled turn, as reported by its own handle. */
export interface ChildTurnResult {
	output: string;
	outcome: ChildTurnOutcome;
}

/** Terminal outcome of one attempt on a child run. `cancelled` is recorded only by an explicit interrupt-with-reason. */
export type ChildRunAttemptOutcome = "completed" | "failed" | "interrupted" | "cancelled";

/**
 * One launch-or-resume epoch of a child run (spec 2026-09-09, "Child
 * lifecycle"): a launch is attempt 1; a resume closes the prior attempt with
 * its terminal outcome and opens a new one. A live run's follow-ups and
 * steering stay inside the active attempt. `usage` snapshots the child's own
 * budget controller when its session exposes one (optional on the handle).
 * `tokensAtEnd` snapshots the run-level usage/cost rollup (see
 * `ChildRunUsageTotals`) at the attempt's settlement: these are
 * CUMULATIVE-AT-END snapshots of the child's whole transcript, never per-attempt
 * deltas -- range attribution between attempts is not attempted because turns
 * that settled after the last persisted boundary are re-run on resume, so the
 * transcript alone cannot attribute usage to an epoch.
 */
export interface ChildRunAttempt {
	id: string;
	startedAt: number;
	endedAt?: number;
	outcome?: ChildRunAttemptOutcome;
	error?: string;
	usage?: AgentRunBudgetUsage;
	tokensAtEnd?: ChildRunUsageTotals;
}

export interface ChildSessionHandle {
	readonly status: ChildSessionStatus;
	/** Run the task to completion and return the child's final output text. */
	run(task: string): Promise<{ output: string }>;
	/**
	 * The latest settled turn's output and terminal outcome, derived by this handle
	 * from the actual prompt resolution; `undefined` before any turn settles. This --
	 * not the registry's stored first-turn promise -- is the source of truth for
	 * background retrieval after `sendInput`/`followUp`/resume.
	 */
	latestResult(): ChildTurnResult | undefined;
	wait(): Promise<void>;
	interrupt(): void;
	close(): void;
	sendInput(input: string): Promise<void>;
	followUp(input: string): Promise<void>;
	/**
	 * Point-in-time snapshot of the child's own run budget counters, when its
	 * session exposes a controller. Optional: handles whose child session does
	 * not surface a controller simply omit it, and every consumer treats
	 * attempt/status usage as optional.
	 */
	usage?(): AgentRunBudgetUsage | undefined;
	/**
	 * Read-only view of the child's own session entries, when the handle can
	 * reach its (possibly in-memory) session manager. Optional: fixture handles
	 * need not expose it, and the usage rollup consults it only when the child
	 * has no resolvable transcript file (an in-memory child never persisted
	 * one). Without this seam AND a transcript file, the run's usage totals are
	 * simply unreportable (`undefined`), never guessed.
	 */
	sessionEntries?(): readonly SessionEntry[] | undefined;
	/**
	 * The derived policy this handle's child was built with (populated by the
	 * sdk's `buildChildSession` from the request's admission projection and its
	 * own construction values). Optional: fixture handles may omit it, and the
	 * runtime relays it onto the child-run record when present.
	 */
	policy?: ChildRunPolicySnapshot;
	/** Release the child's resources. Called when the child or owning parent is closed. */
	dispose(): void;
}

export interface BuildChildSessionRequest {
	agentType: string;
	definition: AgentDefinition;
	/** The child's tool allowlist, already ceiling-checked -- exactly `definition.tools`, never narrowed. */
	toolNames: string[];
	/**
	 * The admitted capability set from the shared admission projection
	 * (`resolveAdmittedDefinition`). Consumers use it to describe the child;
	 * they must never re-derive it (ADR 0010).
	 */
	capabilities: ReadonlySet<Capability>;
	/** The child's own recursion depth (the parent's depth + 1), for the runtime constructing it to record on the child's session header (task 5.3). */
	depth: number;
	/** Stable id used for the child session and its artifact directory. */
	sessionId: string;
	/** Per-child artifact root, created before the child session is constructed. */
	artifactDir?: string;
	workspace?: ChildWorkspaceRequest;
	/**
	 * Reattachment marker (restart reconstruction): when set, `buildChildSession`
	 * opens this existing child session transcript instead of creating a new
	 * session. The path must be the child's own session file under its recorded
	 * artifact directory. Every other field keeps its fresh-delegation meaning,
	 * so permission/model/tool wiring has exactly one construction path.
	 */
	reattachSessionPath?: string;
	/**
	 * Optional wall-time cap for the child's OWN run budget (spec 2026-09-09,
	 * timeouts): forwarded as `maxWallTimeMs` so the existing AgentRunBudget
	 * wall-time gate enforces it mid-run. The launch also records
	 * `deadlineMs = Date.now() + timeoutMs` on the record for lazy observation.
	 */
	timeoutMs?: number;
}

/** The workspace authority requested by a child. Paths are advisory claims,
 * never a replacement for the path-permission gate. */
export interface ChildWorkspaceRequest {
	isolation: "shared-read" | "worktree";
	ownedPaths: readonly string[];
	/**
	 * The resolved isolation root a workspace owner prepared for this child
	 * (worktree isolation): absent on the raw request, present on what
	 * `prepare()` returns, and the cwd the child session runs in.
	 */
	root?: string;
}

/**
 * Lifecycle state of a worktree-isolated child's workspace, persisted on the
 * record (spec 2026-09-09, "Workspace states and explicit recovery"). Absent
 * means "active" -- legacy records predate the field and a live worktree is
 * active by definition. Release outcomes write "released" / "retained-dirty" /
 * "retained-failed"; observing a vanished root at resume writes "missing".
 * Explicit recovery (`recoverWorkspace`) verifies and writes "active".
 */
export type ChildWorkspaceState = "active" | "released" | "retained-dirty" | "retained-failed" | "missing";

/** Success payload of explicit workspace recovery (`recoverChildWorkspace`). */
export interface ChildWorkspaceRecoveryResult {
	/** Always "active": the workspace was verified and reactivated. */
	workspaceState: ChildWorkspaceState;
	/** The verified worktree holds uncommitted or untracked work. */
	dirty: boolean;
}

/**
 * Real isolation and cleanup for a child's requested workspace authority (spec
 * 2026-09-09, "Parallel work and ownership"): the workspace subsystem owns git;
 * delegation only negotiates the request and refuses worktree isolation when no
 * owner is available. `prepare()` runs only for `isolation: "worktree"` -- a
 * shared-read delegation never touches an owner and never invokes git -- and
 * the request it returns (with `root` set) is what `buildChildSession` receives.
 */
/**
 * Terminal outcome of releasing a child workspace (worktree). A kept tree is
 * never destroyed silently: "dirty" means uncommitted/untracked child work
 * was preserved; "failed" means the remove failed for another reason and the
 * tree was left in place.
 */
export type WorkspaceReleaseOutcome =
	| { removed: true }
	| { removed: false; kept: "dirty" | "failed"; dir: string; error?: string };

export interface ChildWorkspaceOwner {
	prepare(request: ChildWorkspaceRequest & { sessionId: string }): Promise<ChildWorkspaceRequest>;
	/**
	 * Release the child's workspace, reporting what happened instead of
	 * throwing. `options.force` is the caller's explicit escape hatch to
	 * force-remove a dirty tree; without it a dirty tree must be kept.
	 */
	release(
		sessionId: string,
		options?: { force?: boolean },
	): Promise<WorkspaceReleaseOutcome> | WorkspaceReleaseOutcome;
	/**
	 * Read-only verification that a recorded worktree root is still this
	 * owner's worktree for the session in the CURRENT workspace: layout,
	 * administrative entry, and checked-out branch. Never creates, checks out,
	 * resets, or force-removes anything; a failed check throws with the check
	 * named. Optional: owners that cannot verify simply never support explicit
	 * recovery, and `recoverWorkspace` refuses rather than guessing.
	 */
	verify?(sessionId: string, root: string): Promise<{ dirty: boolean }> | { dirty: boolean };
}

export interface DelegationRuntimeOptions {
	resolveAgent: AgentDefinitionResolver;
	/** The parent's own effective capability set (its authority), unexpanded -- `exec` expansion happens inside the ceiling check, not here. */
	getParentCapabilities: () => ReadonlySet<Capability>;
	/** Capability set a named tool requires, from the live registry. `undefined` for an unknown tool name. */
	getToolCapabilities: (toolName: string) => ReadonlySet<Capability> | undefined;
	/** The parent session's own recursion depth (`SessionManager.getDelegationDepth()`), read fresh at delegation time. */
	getDelegationDepth: () => number;
	/** Delegation is refused once `getDelegationDepth() >= maxDelegationDepth` -- assigned by the runtime, not by the tool, so the bound applies to any future delegation entry point. */
	maxDelegationDepth: number;
	/**
	 * Maximum simultaneously-active child runs this runtime admits (spec
	 * 2026-09-09, "Shared budgets", concurrency cap). Checked at admission --
	 * before any child session is built -- and refused with an actionable error
	 * naming the limit. An admitted run holds one slot until terminal settlement
	 * (completed/failed/interrupted), close, registry disposal, or launch
	 * failure. `undefined` (default) is unlimited.
	 */
	maxConcurrentChildren?: number;
	/** Parent session directory. When supplied, child artifacts are rooted beneath it. */
	getParentSessionDir?: () => string;
	/**
	 * Parent session id. When supplied, child-run records carry
	 * `parentSessionId`, tying the durable record (and every protocol payload
	 * derived from it) to the parent session's own identity.
	 */
	getParentSessionId?: () => string;
	buildChildSession: (request: BuildChildSessionRequest) => Promise<ChildSessionHandle>;
	childRunRegistry?: ChildRunRegistry;
	/** Durable session owner. Records are appended to the parent session's existing log. */
	persistChildRun?: (record: ChildRunRecord) => void;
	/** Optional workspace owner. It is responsible for real isolation and cleanup. */
	workspaceOwner?: ChildWorkspaceOwner;
}

/**
 * Compact, derivable snapshot of the derived policy a child session was built
 * with (spec 2026-09-09, "Derive, do not reconstruct"). Populated at child
 * construction from the values actually used -- never re-derived by consumers.
 * `capabilities` come from the delegation runtime's single admission projection
 * (`resolveAdmittedDefinition`), so no surface ever re-classifies authority
 * (ADR 0010). Persisted on `ChildRunRecord` and surfaced through status/wait
 * payloads; legacy records without it load unchanged.
 */
export interface ChildRunPolicySnapshot {
	/** The child's tool allowlist, exactly as construction received it (ceiling-checked `definition.tools`). */
	tools: string[];
	/** The admitted capability set from the same admission projection that gated the launch. */
	capabilities: string[];
	/** The delegation depth bound in force for this child's own delegations. */
	maxDelegationDepth: number;
	/** The child's resolved model id (its definition's model, or the parent's current model). */
	model?: string;
	/** The child Agent's budget scope; children are built session-scoped so follow-ups continue one controller. */
	budgetScope: "prompt" | "session";
	/** Whether the child answers to the tree's shared aggregate ceiling (present only when explicitly configured at the root). */
	aggregateBudget: boolean;
}

export interface ChildRunRecord {
	handleId: string;
	agentType: string;
	sessionId?: string;
	task?: string;
	parentSessionId?: string;
	artifactDir?: string;
	/** The derived policy this child was built with, persisted so session readers describe the child without re-deriving it. Optional: legacy records predate the field. */
	policy?: ChildRunPolicySnapshot;
	/**
	 * Legacy only. Records what a session written before ADR 0032 was told about OS
	 * containment. Absent on records written since, because nothing sets it: the
	 * harness ships no boundary and makes no containment claim. Retained so an older
	 * session still parses and still reports what it reported (ADR 0006).
	 */
	sandboxEnforced?: boolean;
	workspace?: ChildWorkspaceRequest;
	/**
	 * Workspace lifecycle state for worktree-isolated records (see
	 * `ChildWorkspaceState`). Written by release outcomes, by resume-time
	 * observation of a vanished root ("missing"), and by explicit recovery
	 * ("active"). Absent -- on legacy records and shared-read runs -- means
	 * "active"; the field only ever appears for worktree isolation.
	 */
	workspaceState?: ChildWorkspaceState;
	depth?: number;
	latestResult?: { output: string; outcome: ChildTurnOutcome };
	status: "created" | "running" | "completed" | "failed" | "interrupted" | "closed";
	updatedAt: number;
	/**
	 * Attempt epochs (launch = attempt 1; resume opens a new one). Optional on
	 * the wire: legacy records predate the field and are synthesized on load --
	 * one attempt derived from the record's status/updatedAt -- so every
	 * in-memory record carries at least one.
	 */
	attempts?: ChildRunAttempt[];
	activeAttemptId?: string;
	/** Caller-supplied spawn dedupe key; a restarted parent rebuilds the key->handle map from records. */
	idempotencyKey?: string;
	/** Wall-clock deadline recorded at launch (`Date.now() + timeoutMs`); observed lazily by status/list. */
	deadlineMs?: number;
	/** Explicit cancellation, recorded when the run is interrupted with a reason. */
	cancelled?: { reason: string; at: number };
}

export interface DelegationResult {
	agentType: string;
	task: string;
	output: string;
	/** Present for background work; pass this handle to retrieveDelegationResult. */
	handleId?: string;
	/**
	 * Terminal outcome of the latest settled turn. Present on registry retrieval
	 * once any turn has settled; the foreground result of the initial run omits it.
	 */
	outcome?: ChildTurnOutcome;
}

/**
 * Non-blocking status snapshot of one child run (`agent/status`,
 * `AgentSession.childRunStatus`). Built from the record/entry alone -- never by
 * awaiting a turn -- so a caller can poll without blocking on the child.
 */
export interface ChildRunStatus {
	handleId: string;
	agentType: string;
	task: string;
	status: ChildSessionStatus;
	/** The active attempt's identity and its latest outcome, if any turn has settled (or a cancellation was recorded). */
	attempt: { id: string; outcome?: ChildRunAttemptOutcome };
	/** Total attempt epochs, including closed ones. */
	attempts: number;
	/** The latest settled turn, as persisted for retrieval. */
	lastResult?: { output: string; outcome: ChildTurnOutcome };
	/** Present when the run was interrupted with an explicit reason. */
	cancelled?: { reason: string; at: number };
	/** Wall-clock launch deadline (present when the spawn carried timeoutMs). */
	deadlineMs?: number;
	/** Snapshot of the child's own budget controller, when its handle exposes one. */
	usage?: AgentRunBudgetUsage;
	/**
	 * Cumulative token totals rolled up from the child's own session transcript
	 * (or its in-memory entries when no transcript exists), flattened from
	 * `ChildRunUsageTotals`. Present beside `cost` whenever a rollup is
	 * reachable; omitted -- never zero-filled -- when nothing is reachable.
	 */
	tokens?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		totalTokens: number;
	};
	/** Provider-reported cost totals corresponding to `tokens`. Absent whenever `tokens` is. */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	/** The run's negotiated workspace authority (isolation plus a prepared root, when a workspace owner provided one). */
	workspace?: { isolation: "shared-read" | "worktree"; root?: string };
	/**
	 * Workspace lifecycle state (worktree-isolated runs only). Present whenever
	 * the workspace is worktree-isolated: the record's persisted state, or
	 * "active" while the entry is live and unretained.
	 */
	workspaceState?: ChildWorkspaceState;
	/** The child's per-run artifact directory, when the child is file-backed. */
	artifactDir?: string;
	/**
	 * The child's transcript path, resolved lazily from its artifact directory
	 * per SessionManager's `<timestamp>_<sessionId>.jsonl` naming. Absent when
	 * the child is in-memory or has not persisted a transcript yet; resolution
	 * never throws.
	 */
	sessionFile?: string;
	/** The parent session id the run belongs to, when the runtime supplies one. */
	parentSessionId?: string;
	/** The derived policy the child was built with; absent on legacy records and fixture handles that never carried one. */
	policy?: ChildRunPolicySnapshot;
	/** Legacy only, surfaced from the record; nothing sets it since ADR 0032. */
	sandboxEnforced?: boolean;
}

/** The registry's record of a handle's latest settled turn. */
type LatestTurnSettlement =
	| { outcome: "completed"; output: string }
	| { outcome: "interrupted"; output: string }
	| { outcome: "failed"; error: unknown };

interface BackgroundDelegation {
	agentType: string;
	task: string;
	promise: Promise<DelegationResult>;
	child?: ChildSessionHandle;
	closed?: boolean;
	/** The latest settled turn; `undefined` until the first settlement is recorded. */
	latest?: LatestTurnSettlement;
	/** The turn whose settlement has not been observed through retrieval yet, if any. */
	pending?: Promise<unknown>;
	/** Durable fields, persisted on every save so a restart can reattach the child session. */
	artifactDir?: string;
	workspace?: ChildWorkspaceRequest;
	depth?: number;
	/** Record linkage persisted with every save (policy snapshot, sandbox flag, parent session id). */
	policy?: ChildRunPolicySnapshot;
	sandboxEnforced?: boolean;
	parentSessionId?: string;
	/** Attempt epochs (spec 2026-09-09, "Child lifecycle"). `register()` supplies attempt 1 when the caller did not. */
	attempts?: ChildRunAttempt[];
	activeAttemptId?: string;
	idempotencyKey?: string;
	deadlineMs?: number;
	cancelled?: { reason: string; at: number };
}

/** Default follow-up prompt for resuming an interrupted child run. */
export const RESUME_CHILD_PROMPT = "Resume the interrupted task and continue from the existing session.";

/** The record status's terminal outcome, for closing an attempt at resume time. */
function terminalOutcomeOfStatus(
	status: ChildRunRecord["status"],
	cancelled?: { reason: string; at: number },
): ChildRunAttemptOutcome | undefined {
	if (status === "completed" || status === "failed") return status;
	if (status === "interrupted") return cancelled ? "cancelled" : "interrupted";
	return undefined;
}

/**
 * Attempts for a record, synthesizing one from legacy fields when the record
 * predates attempt tracking: one attempt, started (and, for a terminal status,
 * ended) at the record's `updatedAt`, with the status mapped to an outcome.
 * Older records therefore load unchanged and still report a single attempt.
 */
function childRunAttemptsOf(record: ChildRunRecord): ChildRunAttempt[] {
	if (record.attempts && record.attempts.length > 0) return record.attempts;
	const attempt: ChildRunAttempt = { id: "attempt-1", startedAt: record.updatedAt };
	const outcome = terminalOutcomeOfStatus(record.status, record.cancelled);
	if (outcome !== undefined) {
		attempt.endedAt = record.updatedAt;
		attempt.outcome = outcome;
	}
	return [attempt];
}

/** The entry's active attempt, falling back to the most recent one. */
function activeAttemptOf(entry: {
	attempts?: ChildRunAttempt[];
	activeAttemptId?: string;
}): ChildRunAttempt | undefined {
	const attempts = entry.attempts ?? [];
	return attempts.find((attempt) => attempt.id === entry.activeAttemptId) ?? attempts[attempts.length - 1];
}

/**
 * Shared delegation admission: definition resolution, recursion-depth bound, and
 * the capability ceiling. One projection for both a fresh delegation and a
 * historical reattachment, so a resumed child can never hold authority the
 * current parent cannot cover (no second classification, ADR 0010). The
 * admitted capability set rides along on the result: it is what the build
 * request carries so the child's policy snapshot describes the same projection
 * instead of recomputing it.
 */
function resolveAdmittedDefinition(
	options: DelegationRuntimeOptions,
	agentType: string,
): { definition: AgentDefinition; capabilities: ReadonlySet<Capability> } {
	const definition = options.resolveAgent(agentType);
	if (!definition) {
		throw new Error(`Unknown agent type "${agentType}".`);
	}
	const depth = options.getDelegationDepth();
	if (depth >= options.maxDelegationDepth) {
		throw new Error(
			`Delegation depth limit (${options.maxDelegationDepth}) reached at depth ${depth}; cannot delegate to agent "${agentType}" further.`,
		);
	}
	const requestedCapabilities = new Set<Capability>();
	for (const toolName of definition.tools) {
		const capabilities = options.getToolCapabilities(toolName);
		if (!capabilities) {
			throw new Error(`Agent "${agentType}" requests unknown tool "${toolName}".`);
		}
		for (const capability of capabilities) requestedCapabilities.add(capability);
	}
	const ceiling = computeCapabilityCeiling(options.getParentCapabilities(), requestedCapabilities);
	if (!ceiling.allowed) {
		throw new Error(
			`Delegating to agent "${agentType}" requires capability "${ceiling.deniedCapability}", which exceeds the parent's authority.`,
		);
	}
	return { definition, capabilities: ceiling.capabilities };
}

/**
 * Lazily resolve a child's transcript path under its artifact directory, per
 * SessionManager's `<timestamp>_<sessionId>.jsonl` naming (the timestamp prefix
 * is not recorded, so the directory is scanned). Never throws: an absent
 * directory or transcript -- an in-memory child never persisted one -- simply
 * yields `undefined`, so status payloads can resolve it lazily without
 * becoming fallible. When several transcripts match, the newest wins (resume
 * may have grown the file set).
 */
function resolveSessionFile(artifactDir: string | undefined, sessionId: string | undefined): string | undefined {
	if (!artifactDir || !sessionId) return undefined;
	if (!existsSync(artifactDir)) return undefined;
	try {
		const matches = readdirSync(artifactDir).filter((name) => name.endsWith(`_${sessionId}.jsonl`));
		if (matches.length === 0) return undefined;
		if (matches.length === 1) return join(artifactDir, matches[0]!);
		const newest = matches
			.map((name) => ({ name, mtime: statSync(join(artifactDir, name)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime)[0]!;
		return join(artifactDir, newest.name);
	} catch {
		return undefined;
	}
}

/**
 * Roll provider-reported usage up over session entries (the child's OWN
 * transcript is the source; SessionManager's reader supplies the entries).
 * Every surface that reports child-run usage goes through here, so the numbers
 * are summed exactly once, exactly as the provider reported them: cost is
 * provider-reported, so cache reads are NOT re-priced or re-counted, and an
 * entry without usage contributes zero. Assistant messages carry per-turn
 * usage; compaction and branch-summary entries carry their summarization
 * call's usage, which is additional real spend and therefore included.
 * Returns `undefined` when the entries hold no usage-bearing record at all
 * (nothing to report) -- callers omit rather than zero-fill.
 */
function computeUsageTotals(entries: readonly FileEntry[]): ChildRunUsageTotals | undefined {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let totalTokens = 0;
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	let entriesCounted = 0;
	const add = (usage: Usage | undefined): void => {
		if (!usage) return; // missing/absent usage counts as zero
		inputTokens += usage.input;
		outputTokens += usage.output;
		cacheReadTokens += usage.cacheRead;
		cacheWriteTokens += usage.cacheWrite;
		totalTokens += usage.totalTokens;
		cost.input += usage.cost.input;
		cost.output += usage.cost.output;
		cost.cacheRead += usage.cost.cacheRead;
		cost.cacheWrite += usage.cost.cacheWrite;
		cost.total += usage.cost.total;
	};
	for (const entry of entries) {
		if (entry.type === "message") {
			if (entry.message.role !== "assistant") continue;
			entriesCounted++;
			add(entry.message.usage);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			entriesCounted++;
			add(entry.usage);
		}
	}
	if (entriesCounted === 0) return undefined;
	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		totalTokens,
		cost,
		asOf: Date.now(),
		entriesCounted,
	};
}

// Results deliberately stay available for the lifetime of their parent runtime.
// Phase 5 promises in-process retrieval only; restart durability belongs to Phase 6.
export class ChildRunRegistry {
	private readonly entries = new Map<string, BackgroundDelegation>();
	private readonly workspaceClaims = new Map<string, string[]>();
	private readonly children = new Set<ChildSessionHandle>();
	/**
	 * Session ids whose workspace this registry must release on close/dispose
	 * (spec 2026-09-09, "Parallel work and ownership"): populated by
	 * `trackWorkspace()` when a worktree-isolated delegation is prepared, and
	 * drained exactly once per session id by `releaseWorkspaceOnce()`.
	 */
	private readonly trackedWorkspaces = new Set<string>();
	/** Session ids whose workspace release has already started -- release runs once, never twice. */
	private readonly releasedWorkspaces = new Set<string>();
	/** Last release outcome per session id, surfaced through `workspaceReleaseOutcome()`. */
	private readonly workspaceReleaseOutcomes = new Map<string, WorkspaceReleaseOutcome>();
	private workspaceOwner?: ChildWorkspaceOwner;
	private disposed = false;
	private persist?: (record: ChildRunRecord) => void;
	private records = new Map<string, ChildRunRecord>();
	/**
	 * Spawn dedupe keys -> handle ids (spec 2026-09-09, idempotent spawn). A
	 * second spawn with a known key returns the existing handle and never builds
	 * a second child. Populated at launch and rebuilt from persisted records on
	 * `restore()`, so a restarted parent dedupes too.
	 */
	private readonly idempotencyKeys = new Map<string, string>();
	/**
	 * Handle ids currently holding a concurrency slot (spec 2026-09-09,
	 * "Shared budgets"). Admission takes one slot per child run BEFORE any child
	 * session is built; the slot is released on terminal settlement
	 * (completed/failed/interrupted), close, registry disposal, or launch
	 * failure. Keyed by handle id, so release is idempotent.
	 */
	private readonly heldRunSlots = new Set<string>();
	/**
	 * The delegation runtime this registry runs under, attached by the session
	 * that owns it (sdk wiring) or by the first `runDelegation` call. Historical
	 * resume reattaches through the SAME `buildChildSession` seam a live
	 * delegation uses; without an attached runtime, historical records are still
	 * listed and their persisted output retrievable, but they cannot reattach.
	 */
	private runtimeOptions?: DelegationRuntimeOptions;
	/**
	 * Last-computed usage totals per handle id, keyed by what makes them stale
	 * (the transcript file's size+mtime, or the in-memory entry count+last id).
	 * The transcript file itself stays the one source: on every read the key is
	 * re-derived and a mismatch recomputes from the file -- this cache never
	 * becomes a second transcript.
	 */
	private readonly usageCache = new Map<string, { key: string; totals: ChildRunUsageTotals }>();
	/** First attach wins: a registry is owned by one session's runtime. */
	setRuntimeOptions(options: DelegationRuntimeOptions): void {
		if (!this.runtimeOptions) this.runtimeOptions = options;
	}
	setPersistence(persist: (record: ChildRunRecord) => void): void {
		this.persist = persist;
	}
	/** Load validated historical records. This never constructs or starts a child. */
	restore(records: readonly ChildRunRecord[]): void {
		for (const record of records) {
			if (
				!record ||
				typeof record.handleId !== "string" ||
				typeof record.agentType !== "string" ||
				!Number.isFinite(record.updatedAt) ||
				!["created", "running", "completed", "failed", "interrupted", "closed"].includes(record.status)
			)
				continue;
			// Legacy records without attempts load with one synthesized attempt
			// derived from their status/updatedAt, so every in-memory record carries
			// at least one attempt.
			const normalized: ChildRunRecord = { ...record, attempts: childRunAttemptsOf(record) };
			if (normalized.activeAttemptId === undefined) {
				const openStatus = normalized.status === "running" || normalized.status === "created";
				normalized.activeAttemptId = openStatus
					? normalized.attempts![normalized.attempts!.length - 1]!.id
					: undefined;
			}
			// Stale-running reconciliation (restart semantics): a persisted
			// "running" record cannot be live in this fresh process, so its
			// in-memory status becomes "interrupted" and its active attempt closes
			// as interrupted. The historical JSONL is never rewritten here -- the
			// corrected status persists with the record's NEXT save (e.g. a resume).
			// This is also the honest statement of restart semantics: a resumed run
			// continues from the last persisted transcript boundary, never
			// exactly-once -- turns that settled after the last save are re-run.
			if (normalized.status === "running") {
				normalized.status = "interrupted";
				normalized.attempts = normalized.attempts!.map((attempt) => ({ ...attempt }));
				const attempt = normalized.attempts[normalized.attempts.length - 1];
				if (attempt) {
					attempt.endedAt ??= Date.now();
					attempt.outcome ??= "interrupted";
				}
			}
			this.records.set(normalized.handleId, normalized);
			if (typeof normalized.idempotencyKey === "string") {
				this.idempotencyKeys.set(normalized.idempotencyKey, normalized.handleId);
			}
		}
	}
	/** The handle a spawn dedupe key already maps to, if any. */
	handleForIdempotencyKey(key: string): string | undefined {
		return this.idempotencyKeys.get(key);
	}
	/** True when `id` is known only as a persisted record -- no live entry in this process. */
	isHistorical(id: string): boolean {
		return !this.entries.has(id) && this.records.has(id);
	}
	/**
	 * Resolve a historical record's child session file. Verified against
	 * SessionManager's naming (`<timestamp>_<sessionId>.jsonl` inside the
	 * per-child artifact directory, which IS the child's session dir): the
	 * timestamp prefix is not recorded, so the directory is scanned for the file
	 * whose name ends in `_<sessionId>.jsonl`. Returns the validated triple so
	 * the reattachment request carries checked values, not optional record fields.
	 */
	private resolveHistoricalSession(record: ChildRunRecord): { path: string; sessionId: string; artifactDir: string } {
		const artifactDir = record.artifactDir ? resolve(record.artifactDir) : undefined;
		const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
		if (!sessionId || !artifactDir) {
			throw new Error(
				`Child run "${record.handleId}" was never file-backed (no persisted child session directory; in-memory child), so it cannot be resumed after restart.`,
			);
		}
		if (!existsSync(artifactDir)) {
			throw new Error(
				`Child run "${record.handleId}" cannot be resumed: its artifact directory is missing: ${artifactDir}.`,
			);
		}
		const path = resolveSessionFile(artifactDir, sessionId);
		if (!path) {
			throw new Error(
				`Child run "${record.handleId}" cannot be resumed: no child session file for session "${sessionId}" exists under ${artifactDir} (the child never persisted a transcript).`,
			);
		}
		return { path, sessionId, artifactDir };
	}
	/**
	 * Reattach a persisted child run to its existing child session and continue
	 * it with one turn (restart reconstruction). The child session file recorded
	 * under the run's artifact directory is reopened through the same
	 * `buildChildSession` seam a live delegation uses (reattachment marker), and
	 * the run then behaves like any live entry: settlement is observed and
	 * persisted, and wait/retrieve/sendInput work on the same handle id.
	 *
	 * Never-file-backed (in-memory) children, records whose artifact directory or
	 * session file is gone, closed runs, and runs whose recorded worktree was
	 * released all refuse with an actionable error; nothing is reconstructed
	 * from nothing.
	 */
	async resumeHistorical(id: string, input?: string): Promise<ChildSessionStatus> {
		this.assertOpen();
		if (this.entries.has(id)) {
			throw new Error(
				`Child run "${id}" is already live in this process; use sendInput instead of historical resume.`,
			);
		}
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown delegation handle "${id}".`);
		// The worktree gate runs BEFORE the closed check: a retained (or missing)
		// workspace is the more actionable refusal for a released child, and it
		// names the persisted state and the explicit-recovery way out.
		if (record.workspace?.isolation === "worktree") this.rejectUnresumableWorktree(id, record);
		if (record.status === "closed") throw new Error(`Child run "${id}" was closed and cannot be resumed.`);
		if (typeof record.agentType !== "string" || record.agentType === "") {
			throw new Error(`Child run "${id}" has a malformed record (no agent type) and cannot be resumed.`);
		}
		const { path: sessionPath, sessionId, artifactDir } = this.resolveHistoricalSession(record);
		const runtime = this.runtimeOptions;
		if (!runtime?.buildChildSession) {
			throw new Error(`Child run "${id}" cannot be resumed: no delegation runtime is attached to this registry.`);
		}
		const { definition, capabilities } = resolveAdmittedDefinition(runtime, record.agentType);
		const workspace = record.workspace ?? { isolation: "shared-read" as const, ownedPaths: [] as string[] };
		const claims = [...workspace.ownedPaths].map((p) => resolve(p));
		for (const claim of this.activeWorkspaceClaims()) {
			if (claims.some((path) => claimPathsOverlap(path, claim))) {
				throw new Error(`Resuming child run "${id}" overlaps an active write ownership claim.`);
			}
		}
		this.claimWorkspace(id, claims);
		try {
			// A resumed run counts against the concurrency limit exactly like a
			// live delegation, from before the child is built (spec 2026-09-09,
			// "Shared budgets").
			this.admitChildRun(id);
			const child = await runtime.buildChildSession({
				agentType: record.agentType,
				definition,
				toolNames: definition.tools,
				capabilities,
				depth: typeof record.depth === "number" ? record.depth : 1,
				sessionId,
				artifactDir,
				workspace,
				reattachSessionPath: sessionPath,
			});
			this.own(child);
			// Resume closes the previous attempt with its terminal outcome and opens
			// a NEW attempt (spec 2026-09-09, "Child lifecycle"): the resumed turn
			// is a fresh epoch of the same child session, never a continuation of
			// the interrupted attempt.
			const priorAttempts = childRunAttemptsOf(record).map((attempt) => ({ ...attempt }));
			const priorOutcome = terminalOutcomeOfStatus(record.status, record.cancelled);
			const prior = record.activeAttemptId
				? priorAttempts.find((attempt) => attempt.id === record.activeAttemptId)
				: undefined;
			const closing = prior ?? priorAttempts[priorAttempts.length - 1];
			if (closing && closing.endedAt === undefined) {
				closing.endedAt = Date.now();
				closing.outcome ??= priorOutcome;
			}
			// The resumed epoch's predecessor gets its cumulative-at-end rollup
			// here when the settlement before the restart never produced one: the
			// persisted transcript is all that survived, so its current totals are
			// the honest snapshot (see ChildRunAttempt.tokensAtEnd).
			if (closing && closing.tokensAtEnd === undefined) {
				const totals = this.usageTotalsFor(id, record.artifactDir);
				if (totals) closing.tokensAtEnd = totals;
			}
			const attempt: ChildRunAttempt = { id: `attempt-${priorAttempts.length + 1}`, startedAt: Date.now() };
			const entry: BackgroundDelegation = {
				agentType: record.agentType,
				task: record.task ?? "",
				// No initial-turn promise: each resumed turn is tracked through
				// sendInput's settlement observation, like any live entry.
				promise: new Promise<DelegationResult>(() => {}),
				child,
				artifactDir: record.artifactDir,
				workspace,
				depth: record.depth,
				// Record linkage: the reattached construction re-derives the policy
				// through the same admission projection; the record's persisted
				// values stand in when a fixture handle reports none.
				policy: child.policy ?? record.policy,
				sandboxEnforced: record.sandboxEnforced,
				parentSessionId: record.parentSessionId,
				attempts: [...priorAttempts, attempt],
				activeAttemptId: attempt.id,
				idempotencyKey: typeof record.idempotencyKey === "string" ? record.idempotencyKey : undefined,
			};
			this.entries.set(id, entry);
			this.save(id, entry, "running");
			await this.sendInput(id, input ?? RESUME_CHILD_PROMPT);
			return child.status;
		} catch (error) {
			this.releaseChildRunSlot(id);
			this.releaseWorkspace(id);
			throw error;
		}
	}
	/**
	 * Gate a worktree-isolated historical resume on the workspace's persisted
	 * state (spec 2026-09-09, "Workspace states and explicit recovery"). A
	 * vanished root classifies the record "missing" (persisted) and refuses; a
	 * retained (dirty/failed) root refuses, naming the persisted state and
	 * pointing at explicit recovery. Legacy records and recovered ("active")
	 * workspaces pass. Read-only: nothing is recreated, checked out, or reset.
	 */
	private rejectUnresumableWorktree(id: string, record: ChildRunRecord): void {
		const workspace = record.workspace!;
		const root = workspace.root;
		if (!root) return; // never prepared: the launch failed before the owner ran
		if (!existsSync(root)) {
			if (record.workspaceState !== "released") {
				record.workspaceState = "missing";
				record.updatedAt = Date.now();
				try {
					this.persist?.(record);
				} catch {
					// The in-memory classification stands even if persistence cannot.
				}
			}
			throw new Error(
				`Child run "${id}" cannot be resumed: its worktree workspace "${root}" no longer exists ` +
					`(workspace state: "${record.workspaceState ?? "missing"}"). Worktrees are released or retained when the ` +
					`owning session closes; a missing workspace cannot be recovered -- start a new delegation instead.`,
			);
		}
		if (record.workspaceState === "retained-dirty" || record.workspaceState === "retained-failed") {
			throw new Error(
				`Child run "${id}" cannot be resumed: its worktree workspace "${root}" was retained at release ` +
					`(workspace state: "${record.workspaceState}"; uncommitted work is preserved there). Recover it explicitly first -- ` +
					`recoverChildWorkspace("${id}") verifies the worktree and reactivates it -- then resume.`,
			);
		}
	}
	/**
	 * Explicitly verify and reactivate a retained child worktree (spec
	 * 2026-09-09, "Workspace states and explicit recovery"). Read-only
	 * inspection only -- the workspace owner's verification reads the
	 * administrative entry and the checked-out branch and never creates,
	 * checks out, resets, or force-removes anything -- and on success the
	 * record's workspace state becomes "active" (persisted) so the child can be
	 * resumed in the SAME worktree. Automatic recreation stays out of scope by
	 * design: every failed check refuses with an actionable error naming the
	 * failed check, and the workspace state stays unverified.
	 */
	async recoverWorkspace(id: string): Promise<ChildWorkspaceRecoveryResult> {
		this.assertOpen();
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown delegation handle "${id}".`);
		const workspace = record.workspace;
		if (!workspace || workspace.isolation !== "worktree" || !workspace.root) {
			throw new Error(
				`Child workspace recovery refused for run "${id}": it has no worktree workspace to recover ` +
					`(isolation: ${workspace?.isolation ?? "none"}). Only worktree-isolated children hold a recoverable workspace; ` +
					`nothing was verified and the record is unchanged.`,
			);
		}
		const root = workspace.root;
		if (!existsSync(root)) {
			if (record.workspaceState !== "released") {
				record.workspaceState = "missing";
				record.updatedAt = Date.now();
				try {
					this.persist?.(record);
				} catch {
					// The in-memory classification stands even if persistence cannot.
				}
			}
			throw new Error(
				`Child workspace recovery refused for run "${id}": its recorded worktree root "${root}" does not exist ` +
					`(workspace state: "${record.workspaceState ?? "missing"}"). A missing workspace cannot be recovered; ` +
					`nothing was created.`,
			);
		}
		const owner = this.workspaceOwner ?? this.runtimeOptions?.workspaceOwner;
		if (!owner || typeof owner.verify !== "function") {
			throw new Error(
				`Child workspace recovery refused for run "${id}": no workspace owner with verification is available for ` +
					`this session. The workspace at "${root}" was not inspected and stays unverified.`,
			);
		}
		let dirty: boolean;
		try {
			({ dirty } = await owner.verify(id, root));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Child workspace recovery refused for run "${id}": ${detail} No recovery was performed and the ` +
					`workspace stays unverified.`,
			);
		}
		record.workspaceState = "active";
		record.updatedAt = Date.now();
		try {
			this.persist?.(record);
		} catch {
			// The in-memory record is reactivated regardless; the persisted state
			// catches up with the next save.
		}
		return { workspaceState: "active", dirty };
	}
	/**
	 * The owner consulted when a tracked child's lifecycle ends. Optional:
	 * without one, close/dispose still clean claims but release nothing.
	 */
	setWorkspaceOwner(owner: ChildWorkspaceOwner | undefined): void {
		this.workspaceOwner = owner;
	}
	/** Record that a child session's workspace (worktree) must be released when its lifecycle ends. */
	trackWorkspace(sessionId: string): void {
		this.trackedWorkspaces.add(sessionId);
	}
	/**
	 * Release a tracked child's workspace through the owner, once per session
	 * id. Best effort: a missing owner is tolerated and an owner failure never
	 * propagates -- cleanup must never break close or dispose. The outcome is
	 * stored per session id (`workspaceReleaseOutcome()`), and a kept tree is
	 * warned about loudly so silent data loss cannot hide behind best-effort
	 * cleanup.
	 */
	private releaseWorkspaceOnce(sessionId: string): Promise<void> {
		if (this.releasedWorkspaces.has(sessionId)) return Promise.resolve();
		this.releasedWorkspaces.add(sessionId);
		this.trackedWorkspaces.delete(sessionId);
		const owner = this.workspaceOwner;
		if (!owner) return Promise.resolve();
		return Promise.resolve()
			.then(() => owner.release(sessionId))
			.catch(
				(error: unknown): WorkspaceReleaseOutcome => ({
					removed: false,
					kept: "failed",
					dir: "",
					error: error instanceof Error ? error.message : String(error),
				}),
			)
			.then((outcome) => {
				this.workspaceReleaseOutcomes.set(sessionId, outcome);
				this.recordWorkspaceState(sessionId, outcome);
				if (!outcome.removed) {
					if (outcome.kept === "dirty") {
						console.warn(
							`[apex-code] Child worktree for session "${sessionId}" kept at ${outcome.dir}; uncommitted child work preserved. ` +
								`Resume after reattach is refused for worktree children. Manual removal: git worktree remove --force ${outcome.dir}`,
						);
					} else {
						console.warn(
							`[apex-code] Child worktree release failed for session "${sessionId}" (tree kept at ${outcome.dir}): ${outcome.error ?? "unknown error"}`,
						);
					}
				}
			})
			.catch(() => undefined);
	}
	/**
	 * Classify a finished release on the record (spec 2026-09-09, "Workspace
	 * states and explicit recovery"): removed -> "released", kept dirty ->
	 * "retained-dirty", kept failed -> "retained-failed". Only worktree-isolated
	 * records carry the state. The classified record persists immediately -- even
	 * though release is fire-and-forget -- so a restarted parent sees the
	 * classification and can refuse or recover accordingly.
	 */
	private recordWorkspaceState(sessionId: string, outcome: WorkspaceReleaseOutcome): void {
		const record = this.records.get(sessionId);
		if (!record || record.workspace?.isolation !== "worktree") return;
		record.workspaceState = outcome.removed
			? "released"
			: outcome.kept === "dirty"
				? "retained-dirty"
				: "retained-failed";
		record.updatedAt = Date.now();
		try {
			this.persist?.(record);
		} catch {
			// The in-memory record still carries the classification even when
			// persistence cannot run (best effort, like the release itself).
		}
	}
	/** The stored outcome of this session id's workspace release, if it has run. */
	workspaceReleaseOutcome(sessionId: string): WorkspaceReleaseOutcome | undefined {
		return this.workspaceReleaseOutcomes.get(sessionId);
	}
	/** Awaitable variant for the delegation failure path, which must release before the throw surfaces. */
	async releaseWorkspaceNow(sessionId: string): Promise<void> {
		await this.releaseWorkspaceOnce(sessionId);
		this.workspaceClaims.delete(sessionId);
	}
	releaseWorkspace(sessionId: string): void {
		this.workspaceClaims.delete(sessionId);
	}
	activeWorkspaceClaims(): string[] {
		return [...this.workspaceClaims.values()].flat();
	}
	claimWorkspace(sessionId: string, paths: string[]): void {
		if (paths.length) this.workspaceClaims.set(sessionId, paths);
	}
	private save(handleId: string, entry: BackgroundDelegation, status: ChildRunRecord["status"]): void {
		const latest = entry.latest;
		const record: ChildRunRecord = {
			handleId,
			agentType: entry.agentType,
			sessionId: handleId,
			task: entry.task,
			artifactDir: entry.artifactDir,
			workspace: entry.workspace,
			depth: entry.depth,
			status,
			updatedAt: Date.now(),
			// Attempts, the active attempt, and the spawn dedupe key persist with
			// every save: a restarted parent rebuilds attempts and the key->handle
			// map from these records alone.
			attempts: (entry.attempts ?? []).map((attempt) => ({ ...attempt })),
			activeAttemptId: entry.activeAttemptId,
			// Record linkage (policy snapshot, sandbox flag, parent session id)
			// persists with every save too, so session readers describe the child
			// without re-deriving its policy (spec 2026-09-09, "Derive, do not
			// reconstruct").
			...(entry.parentSessionId !== undefined ? { parentSessionId: entry.parentSessionId } : {}),
			...(entry.policy
				? {
						policy: {
							...entry.policy,
							tools: [...entry.policy.tools],
							capabilities: [...entry.policy.capabilities],
						},
					}
				: {}),
			...(entry.sandboxEnforced !== undefined ? { sandboxEnforced: entry.sandboxEnforced } : {}),
			...(entry.idempotencyKey !== undefined ? { idempotencyKey: entry.idempotencyKey } : {}),
			...(entry.deadlineMs !== undefined ? { deadlineMs: entry.deadlineMs } : {}),
			...(entry.cancelled ? { cancelled: { ...entry.cancelled } } : {}),
		};
		// The settlement's output persists with the record so a historical run's
		// result stays retrievable after restart without reattaching the child.
		if (latest) {
			record.latestResult = {
				output:
					latest.outcome === "failed"
						? latest.error instanceof Error
							? latest.error.message
							: String(latest.error)
						: latest.output,
				outcome: latest.outcome,
			};
		}
		this.records.set(handleId, record);
		this.persist?.(record);
	}
	/**
	 * Record a turn settlement from the child handle's own report, falling back to
	 * the settlement value for handles that did not report. The latest settlement
	 * wins; retrieval serves it instead of the stored first-turn promise.
	 */
	private recordCompletion(id: string, entry: BackgroundDelegation, fallbackOutput: string): void {
		const reported = entry.child?.latestResult?.();
		entry.latest =
			!reported || reported.outcome === "completed"
				? { outcome: "completed", output: reported?.output ?? fallbackOutput }
				: reported.outcome === "interrupted"
					? { outcome: "interrupted", output: reported.output }
					: { outcome: "failed", error: new Error(reported.output || "Child run failed.") };
		this.persistSettlement(id, entry);
	}
	private recordFailure(id: string, entry: BackgroundDelegation, error: unknown): void {
		const reported = entry.child?.latestResult?.();
		entry.latest =
			reported?.outcome === "interrupted" || (!reported && entry.child?.status === "interrupted")
				? { outcome: "interrupted", output: reported?.output ?? "" }
				: { outcome: "failed", error };
		this.persistSettlement(id, entry);
	}
	/**
	 * Stamp the active attempt with the settled turn's outcome. A cancellation
	 * recorded on the entry wins for an interrupted settlement: the attempt
	 * stays `cancelled` instead of downgrading to plain `interrupted`. Attempt
	 * usage snapshots from the child's own controller where its handle exposes
	 * one; handles without a controller leave usage unset. `tokensAtEnd`
	 * snapshots the run-level token/cost rollup at settlement time (a
	 * cumulative-at-end snapshot of the whole transcript -- see
	 * `ChildRunAttempt`); when nothing is reachable it stays unset.
	 */
	private stampAttemptSettlement(id: string, entry: BackgroundDelegation): void {
		const attempt = activeAttemptOf(entry);
		const latest = entry.latest;
		if (!attempt || !latest) return;
		attempt.outcome = latest.outcome === "interrupted" && entry.cancelled ? "cancelled" : latest.outcome;
		if (latest.outcome === "failed") {
			attempt.error = latest.error instanceof Error ? latest.error.message : String(latest.error);
		}
		const usage = entry.child?.usage?.();
		if (usage) attempt.usage = usage;
		const totals = this.usageTotalsFor(id, entry.artifactDir, entry.child);
		if (totals) attempt.tokensAtEnd = totals;
	}
	/** Persist the settlement's status. A closed run's terminal status is never overwritten by late settlement. */
	private persistSettlement(id: string, entry: BackgroundDelegation): void {
		if (entry.closed) return;
		const latest = entry.latest;
		if (!latest) return;
		this.stampAttemptSettlement(id, entry);
		this.save(
			id,
			entry,
			latest.outcome === "completed" ? "completed" : latest.outcome === "interrupted" ? "interrupted" : "failed",
		);
		// Terminal settlement (completed/failed/interrupted) releases the run's
		// concurrency slot (spec 2026-09-09, "Shared budgets").
		this.releaseChildRunSlot(id);
	}
	assertOpen(): void {
		if (this.disposed) throw new Error("Child run registry is disposed.");
	}
	/** The configured child-run concurrency limit, if any. */
	private concurrencyLimit(): number | undefined {
		const limit = this.runtimeOptions?.maxConcurrentChildren;
		return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
	}
	/**
	 * Concurrency admission (spec 2026-09-09, "Shared budgets"): refuse with an
	 * actionable error naming the limit BEFORE any child session is built when
	 * every slot is occupied. An admitted run holds one slot until terminal
	 * settlement, close, dispose, or a launch failure releases it.
	 */
	admitChildRun(handleId: string): void {
		const limit = this.concurrencyLimit();
		if (limit === undefined) return;
		if (this.heldRunSlots.size >= limit) {
			throw new Error(
				`Delegation refused: maxConcurrentChildren=${limit} and ${this.heldRunSlots.size} child run(s) are still active. Wait for a child run to finish or close it, or raise maxConcurrentChildren.`,
			);
		}
		this.heldRunSlots.add(handleId);
	}
	/** Release a run's concurrency slot. Idempotent. */
	releaseChildRunSlot(handleId: string): void {
		this.heldRunSlots.delete(handleId);
	}
	own(child: ChildSessionHandle): void {
		if (this.disposed) {
			child.dispose();
			this.assertOpen();
		}
		this.children.add(child);
	}
	release(child: ChildSessionHandle): void {
		if (this.children.delete(child)) child.dispose();
	}
	register(id: string, entry: BackgroundDelegation): void {
		this.assertOpen();
		// A launch is attempt 1: an entry without attempts starts its first epoch
		// here (resumeHistorical supplies its own carried-over attempts).
		if (entry.attempts === undefined || entry.attempts.length === 0) {
			entry.attempts = [{ id: "attempt-1", startedAt: Date.now() }];
			entry.activeAttemptId ??= entry.attempts[0]!.id;
		}
		if (entry.idempotencyKey !== undefined) {
			this.idempotencyKeys.set(entry.idempotencyKey, id);
		}
		if (!this.entries.has(id)) {
			this.entries.set(id, entry);
			// Observe the initial turn's settlement here so the latest result is
			// recorded even when retrieval never happens; this derived branch always
			// resolves, so it can never become an unhandled rejection itself.
			const settled = entry.promise.then(
				(result) => {
					this.recordCompletion(id, entry, result.output);
					return result;
				},
				(error) => {
					this.recordFailure(id, entry, error);
					return undefined as unknown as DelegationResult;
				},
			);
			void settled.catch(() => undefined);
			entry.pending = settled;
		}
		this.save(id, entry, "created");
	}
	retrieve(id: string, expected?: string): Promise<DelegationResult> {
		const entry = this.entries.get(id);
		if (!entry) {
			const record = this.records.get(id);
			if (!record) throw new Error(`Unknown delegation handle "${id}".`);
			if (expected !== undefined && record.agentType !== expected)
				throw new Error(`Delegation handle "${id}" belongs to agent "${record.agentType}", not "${expected}".`);
			const latest = record.latestResult;
			if (!latest) {
				throw new Error(
					`Child run "${id}" has no persisted output, so its result cannot be recovered after restart. Resume it with resumeChildRun("${id}") to reattach its child session.`,
				);
			}
			return Promise.resolve({
				agentType: record.agentType,
				task: record.task ?? "",
				output: latest.output,
				outcome: latest.outcome,
			});
		}
		if (expected !== undefined && entry.agentType !== expected)
			throw new Error(`Delegation handle "${id}" belongs to agent "${entry.agentType}", not "${expected}".`);
		return this.latestDelegationResult(entry);
	}
	/** Await any in-flight turn, then serve its settled outcome -- not the stored first-turn promise. */
	private async latestDelegationResult(entry: BackgroundDelegation): Promise<DelegationResult> {
		if (entry.pending) await entry.pending.catch(() => undefined);
		const latest = entry.latest;
		if (!latest) return entry.promise;
		if (latest.outcome === "failed") throw latest.error;
		return { agentType: entry.agentType, task: entry.task, output: latest.output, outcome: latest.outcome };
	}
	/**
	 * One entry per child run -- live entries first, then historical records --
	 * each as `{handleId, agentType, task, status, attemptCount}`. Backward
	 * compatible: fields were only ever added. Observing the list lazily
	 * interrupts a live running child whose wall-clock deadline has passed.
	 */
	list(): { handleId: string; agentType: string; task: string; status: ChildSessionStatus; attemptCount: number }[] {
		this.observeDeadlines();
		const historical = [...this.records]
			.filter(([id]) => !this.entries.has(id))
			.map(([handleId, record]) => ({
				handleId,
				agentType: record.agentType,
				task: record.task ?? "",
				status:
					record.status === "closed"
						? "closed"
						: record.status === "interrupted"
							? "interrupted"
							: record.status === "running"
								? "running"
								: ("idle" as ChildSessionStatus),
				attemptCount: childRunAttemptsOf(record).length,
			}));
		return [...this.entries]
			.map(([handleId, entry]) => ({
				handleId,
				agentType: entry.agentType,
				task: entry.task,
				status: entry.closed ? "closed" : (entry.child?.status ?? "idle"),
				attemptCount: (entry.attempts ?? []).length,
			}))
			.concat(historical);
	}
	/**
	 * Non-blocking status snapshot for one handle (spec 2026-09-09, pollable
	 * status): built from the live entry or the persisted record alone, never by
	 * awaiting a turn. Unknown ids still error. Observing the status lazily
	 * interrupts a live running child whose wall-clock deadline has passed, so a
	 * timed-out run is reported (and stopped) at observation time.
	 */
	status(id: string): ChildRunStatus {
		this.assertOpen();
		this.observeDeadlines();
		const entry = this.entries.get(id);
		if (entry) return this.statusFromEntry(id, entry);
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown delegation handle "${id}".`);
		return this.statusFromRecord(record);
	}
	/**
	 * The run's token/cost totals, rolled up on demand from the child's OWN
	 * session transcript (the session-file reading seam) -- or from the handle's
	 * in-memory session entries when no transcript file exists. Reads lazily and
	 * caches only the last-computed totals, keyed by transcript size/mtime or
	 * entry count, so the cache can never become a second transcript.
	 * `undefined` -- never zero-filled, never a throw -- when nothing is
	 * reachable: an in-memory child without a reachable transcript, or a
	 * historical record whose transcript is gone. Unknown ids error like
	 * `status`.
	 */
	usageTotals(id: string): ChildRunUsageTotals | undefined {
		this.assertOpen();
		const entry = this.entries.get(id);
		if (entry) return this.usageTotalsFor(id, entry.artifactDir, entry.child);
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown delegation handle "${id}".`);
		return this.usageTotalsFor(id, record.artifactDir);
	}
	/**
	 * One rollup read for both live entries and historical records: a
	 * resolvable transcript file wins (the persisted transcript is the source of
	 * truth, including after restart); the handle's in-memory session entries
	 * cover an in-memory child whose transcript was never written.
	 */
	private usageTotalsFor(
		id: string,
		artifactDir: string | undefined,
		child?: ChildSessionHandle,
	): ChildRunUsageTotals | undefined {
		const sessionFile = resolveSessionFile(artifactDir, id);
		if (sessionFile) {
			try {
				const stats = statSync(sessionFile);
				const key = `file:${stats.size}:${stats.mtimeMs}`;
				const cached = this.usageCache.get(id);
				if (cached && cached.key === key) return cached.totals;
				const totals = computeUsageTotals(loadEntriesFromFile(sessionFile));
				if (totals) this.usageCache.set(id, { key, totals });
				return totals;
			} catch {
				// An unreadable transcript falls through to the in-memory seam below;
				// reporting usage must never turn a status read into a failure.
			}
		}
		const entries = child?.sessionEntries?.();
		if (entries) {
			const last = entries[entries.length - 1];
			const key = `mem:${entries.length}:${last?.id ?? ""}`;
			const cached = this.usageCache.get(id);
			if (cached && cached.key === key) return cached.totals;
			const totals = computeUsageTotals(entries);
			if (totals) this.usageCache.set(id, { key, totals });
			return totals;
		}
		return undefined;
	}
	/** The status payload's flattened view of the rollup, omitted when unreachable. */
	private static usageSummaryOf(totals: ChildRunUsageTotals | undefined): {
		tokens?: ChildRunStatus["tokens"];
		cost?: ChildRunStatus["cost"];
	} {
		if (!totals) return {};
		return {
			tokens: {
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheReadTokens: totals.cacheReadTokens,
				cacheWriteTokens: totals.cacheWriteTokens,
				totalTokens: totals.totalTokens,
			},
			cost: { ...totals.cost },
		};
	}
	private statusFromEntry(id: string, entry: BackgroundDelegation): ChildRunStatus {
		const attempt = activeAttemptOf(entry);
		const latest = entry.latest;
		const usage = entry.child?.usage?.();
		const workspace = entry.workspace;
		// The persisted record is the authority for a worktree's lifecycle state
		// (a closed-but-live entry's release may already have classified it);
		// while the record has none the live workspace is simply active.
		const workspaceState = this.records.get(id)?.workspaceState;
		// Entries never carry their own session id: save() always records the
		// handle id as the child session id, so transcript resolution uses it.
		const sessionFile = resolveSessionFile(entry.artifactDir, id);
		return {
			handleId: id,
			agentType: entry.agentType,
			task: entry.task,
			status: entry.closed ? "closed" : (entry.child?.status ?? "idle"),
			attempt: {
				id: attempt?.id ?? "",
				...(attempt?.outcome !== undefined ? { outcome: attempt.outcome } : {}),
			},
			attempts: (entry.attempts ?? []).length,
			...(latest
				? {
						lastResult: {
							output:
								latest.outcome === "failed"
									? latest.error instanceof Error
										? latest.error.message
										: String(latest.error)
									: latest.output,
							outcome: latest.outcome,
						},
					}
				: {}),
			...(entry.cancelled ? { cancelled: { ...entry.cancelled } } : {}),
			...(entry.deadlineMs !== undefined ? { deadlineMs: entry.deadlineMs } : {}),
			...(usage ? { usage } : {}),
			// Token/cost rollup from the child's own transcript, on the same lazy,
			// cached seam `usageTotals` serves; omitted when nothing is reachable.
			...ChildRunRegistry.usageSummaryOf(this.usageTotalsFor(id, entry.artifactDir, entry.child)),
			...(workspace
				? {
						workspace: {
							isolation: workspace.isolation,
							...(workspace.root ? { root: workspace.root } : {}),
						},
						...(workspace.isolation === "worktree" ? { workspaceState: workspaceState ?? "active" } : {}),
					}
				: {}),
			// Record linkage (additive): artifact/session-file/parent identity,
			// the derived policy, and the sandbox flag ride along when known and
			// are simply omitted otherwise.
			...(entry.artifactDir !== undefined ? { artifactDir: entry.artifactDir } : {}),
			...(sessionFile !== undefined ? { sessionFile } : {}),
			...(entry.parentSessionId !== undefined ? { parentSessionId: entry.parentSessionId } : {}),
			...(entry.policy ? { policy: entry.policy } : {}),
			...(entry.sandboxEnforced !== undefined ? { sandboxEnforced: entry.sandboxEnforced } : {}),
		};
	}
	private statusFromRecord(record: ChildRunRecord): ChildRunStatus {
		const attempts = childRunAttemptsOf(record);
		// The active attempt when one is open; otherwise (terminal or legacy
		// record) the most recent attempt carries the reported outcome.
		const attempt = record.activeAttemptId
			? (attempts.find((candidate) => candidate.id === record.activeAttemptId) ?? attempts[attempts.length - 1])
			: attempts[attempts.length - 1];
		const workspace = record.workspace;
		const sessionFile = resolveSessionFile(record.artifactDir, record.sessionId);
		return {
			handleId: record.handleId,
			agentType: record.agentType,
			task: record.task ?? "",
			status:
				record.status === "closed"
					? "closed"
					: record.status === "interrupted"
						? "interrupted"
						: record.status === "running"
							? "running"
							: ("idle" as ChildSessionStatus),
			attempt: {
				id: attempt?.id ?? attempts[attempts.length - 1]?.id ?? "",
				...(attempt?.outcome !== undefined ? { outcome: attempt.outcome } : {}),
			},
			attempts: attempts.length,
			...(record.latestResult ? { lastResult: { ...record.latestResult } } : {}),
			...(record.cancelled ? { cancelled: { ...record.cancelled } } : {}),
			...(record.deadlineMs !== undefined ? { deadlineMs: record.deadlineMs } : {}),
			// Token/cost rollup from the persisted transcript, so a restarted
			// parent reports the same totals without a live child.
			...ChildRunRegistry.usageSummaryOf(this.usageTotalsFor(record.handleId, record.artifactDir)),
			...(workspace
				? {
						workspace: {
							isolation: workspace.isolation,
							...(workspace.root ? { root: workspace.root } : {}),
						},
						// Absent means active (legacy records predate the field).
						...(workspace.isolation === "worktree" ? { workspaceState: record.workspaceState ?? "active" } : {}),
					}
				: {}),
			// Record linkage (additive): legacy records without the fields simply
			// omit them (spec 2026-09-09, policy/sandbox/artifact linkage).
			...(record.artifactDir !== undefined ? { artifactDir: record.artifactDir } : {}),
			...(sessionFile !== undefined ? { sessionFile } : {}),
			...(record.parentSessionId !== undefined ? { parentSessionId: record.parentSessionId } : {}),
			...(record.policy ? { policy: record.policy } : {}),
			...(record.sandboxEnforced !== undefined ? { sandboxEnforced: record.sandboxEnforced } : {}),
		};
	}
	/**
	 * Lazy deadline observation (spec 2026-09-09, timeouts): a live RUNNING child
	 * past its recorded wall-clock deadline is interrupted at observation time.
	 * The interrupt carries no reason -- a wall-time timeout is not a user
	 * cancellation -- so the attempt settles `interrupted`, and the child's own
	 * budget gate names "wall-time" in the settlement error path when the run's
	 * turn was refused for time. Historical records have no live child to
	 * interrupt and are left untouched.
	 */
	private observeDeadlines(): void {
		const now = Date.now();
		for (const [id, entry] of this.entries) {
			if (entry.closed || entry.deadlineMs === undefined || now < entry.deadlineMs) continue;
			if (entry.child?.status !== "running") continue;
			try {
				this.interrupt(id);
			} catch {
				// The child vanished between the check and the interrupt; nothing left to observe.
			}
		}
	}
	private child(id: string): ChildSessionHandle {
		this.assertOpen();
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown delegation handle "${id}".`);
		if (entry.closed) throw new Error(`Child session "${id}" is closed.`);
		if (!entry.child) throw new Error(`Delegation handle "${id}" has no child session.`);
		return entry.child;
	}
	async wait(id: string): Promise<DelegationResult> {
		const entry = this.entries.get(id);
		// A historical record has nothing to await: its persisted settlement (if
		// any) is served through retrieve, which throws the actionable error when
		// no output was persisted.
		if (!entry) return this.retrieve(id);
		if (!entry.closed) {
			const child = this.child(id);
			if (entry.pending || child.status === "running") this.save(id, entry, "running");
			// A turn that ends interrupted or failed rejects here; retrieval below owns
			// propagation, surfacing interrupted as an outcome and failed as a throw.
			await child.wait().catch(() => undefined);
		}
		return this.retrieve(id);
	}
	sendInput(id: string, input: string): Promise<void> {
		// Unknown and closed handles throw synchronously, matching close()'s contract.
		const child = this.child(id);
		const entry = this.entries.get(id)!;
		const turn = child.sendInput(input).then(
			() => {
				this.recordCompletion(id, entry, "");
			},
			(error) => {
				this.recordFailure(id, entry, error);
				throw error;
			},
		);
		void turn.catch(() => undefined);
		entry.pending = turn;
		return turn;
	}
	/**
	 * Interrupt a live child. An optional reason turns the interrupt into an
	 * explicit cancellation: `{reason, at}` is persisted on the record
	 * immediately and the active attempt is marked `cancelled`; without a
	 * reason the attempt settles plain `interrupted` at the turn's settlement.
	 */
	interrupt(id: string, reason?: string): void {
		this.child(id).interrupt();
		if (reason === undefined) return;
		const entry = this.entries.get(id);
		if (!entry) return; // Unreachable: child(id) already validated the handle.
		entry.cancelled = { reason, at: Date.now() };
		const attempt = activeAttemptOf(entry);
		if (attempt) attempt.outcome = "cancelled";
		// The child's post-interrupt handle status maps onto the record's status
		// vocabulary ("idle" is a handle state, not a record state).
		const childStatus = entry.child?.status;
		const recordStatus: ChildRunRecord["status"] = childStatus === "running" ? "running" : "interrupted";
		this.save(id, entry, recordStatus);
	}
	/**
	 * Close a live run's active attempt with its latest settled outcome and open
	 * a new one for the resuming turn (spec 2026-09-09, "Child lifecycle"):
	 * `AgentSession.resumeChildRun` calls this on the live path before
	 * `sendInput` so a resume is a distinct attempt epoch, while ordinary
	 * follow-ups on a live run stay inside the active attempt.
	 */
	beginResumeAttempt(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown delegation handle "${id}".`);
		const prior = activeAttemptOf(entry);
		if (prior && prior.endedAt === undefined) {
			prior.endedAt = Date.now();
			prior.outcome ??= entry.latest?.outcome;
		}
		// A resume close stamps the closed attempt's cumulative-at-end rollup
		// when its settlement never produced one (a settlement-stamped snapshot
		// is never overwritten with the later, larger transcript).
		if (prior && prior.tokensAtEnd === undefined) {
			const totals = this.usageTotalsFor(id, entry.artifactDir, entry.child);
			if (totals) prior.tokensAtEnd = totals;
		}
		const attempts = entry.attempts ?? [];
		const attempt: ChildRunAttempt = { id: `attempt-${attempts.length + 1}`, startedAt: Date.now() };
		attempts.push(attempt);
		entry.attempts = attempts;
		entry.activeAttemptId = attempt.id;
	}
	close(id: string): void {
		this.assertOpen();
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown delegation handle "${id}".`);
		if (entry.closed) return;
		entry.closed = true;
		this.workspaceClaims.delete(id);
		// A closed run's slot is released with it (spec 2026-09-09, "Shared
		// budgets"), even when its turn never settles.
		this.releaseChildRunSlot(id);
		// Release the child's workspace (worktree) with its lifecycle; best effort,
		// fire-and-forget: close() is synchronous and must never throw on cleanup.
		void this.releaseWorkspaceOnce(id);
		this.save(id, entry, "closed");
		if (entry.child) {
			this.children.delete(entry.child);
			entry.child.close();
		}
	}
	/** Stop tracking handles and release any children and workspaces still owned by this registry. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const child of this.children) {
			try {
				child.interrupt();
			} catch {}
			try {
				this.release(child);
			} catch {}
		}
		// Release every tracked child workspace (worktree) with the registry.
		// Best effort and fire-and-forget: dispose() is synchronous.
		for (const sessionId of this.trackedWorkspaces) {
			void this.releaseWorkspaceOnce(sessionId);
		}
		this.entries.clear();
		this.workspaceClaims.clear();
		this.usageCache.clear();
		// No run holds a concurrency slot past the registry's disposal.
		this.heldRunSlots.clear();
	}
}

/**
 * Run one delegation to completion. Throws rather than returning a failure value,
 * matching this codebase's convention for model-facing routine failures (e.g.
 * `tool_schema`'s unknown-tool case, `web_search`'s unconfigured-backend case): a
 * thrown `Error` here is caught by the agent loop and surfaces as a normal,
 * model-readable `isError` tool result, not a fatal turn failure.
 *
 * The capability check is all-or-nothing by design (ceiling.ts): a definition
 * requesting a tool the parent's own capabilities cannot cover refuses the whole
 * delegation, naming the capability, rather than silently building a child missing
 * that one tool. `buildChildSession` is therefore never called for a refused
 * delegation -- there is no code path that produces a child holding a capability
 * outside the ceiling.
 *
 * The depth check (task 5.3) runs right after agent-type resolution and before the
 * capability check, so recursion is bounded regardless of what is being delegated --
 * a refusal at the bound still names the agent type, but never reaches the ceiling
 * or `buildChildSession`. `buildChildSession` receives the child's depth (parent + 1)
 * so the caller can record it on the child's own session header.
 */
/**
 * Whether two resolved paths denote the same directory or either contains the
 * other. Comparison is separator-correct: forward-slash prefix matching
 * silently never matches on platforms whose resolve() produces backslashes.
 */
export function claimPathsOverlap(a: string, b: string): boolean {
	const ab = relative(a, b);
	if (ab !== ".." && !ab.startsWith(`..${sep}`) && !isAbsolute(ab)) return true;
	const ba = relative(b, a);
	return ba !== ".." && !ba.startsWith(`..${sep}`) && !isAbsolute(ba);
}

export async function runDelegation(
	options: DelegationRuntimeOptions,
	agentType: string,
	task: string,
	request: {
		background?: boolean;
		workspace?: ChildWorkspaceRequest;
		handleId?: string;
		/** Spawn dedupe key (spec 2026-09-09, idempotent spawn): a known key returns the EXISTING handle without building a second child. */
		idempotencyKey?: string;
		/** Wall-time cap for the child's own run budget; also recorded as the record's deadlineMs for lazy observation. */
		timeoutMs?: number;
	} = {},
): Promise<DelegationResult> {
	let registry = options.childRunRegistry;
	if (!registry) {
		registry = new ChildRunRegistry();
		options.childRunRegistry = registry;
	}
	registry.assertOpen();
	registry.setRuntimeOptions(options);
	// Idempotent spawn: a key that already maps to a handle returns that handle
	// BEFORE any admission or child construction, so a duplicate spawn consumes
	// no second concurrency slot. The map is rebuilt from persisted records on
	// restore, so a restarted parent dedupes too.
	if (request.idempotencyKey !== undefined) {
		const existing = registry.handleForIdempotencyKey(request.idempotencyKey);
		if (existing !== undefined) {
			return {
				agentType,
				task,
				output: `Delegation already started with handle "${existing}" (idempotency key "${request.idempotencyKey}"); retrieve it with that handle.`,
				handleId: existing,
			};
		}
	}
	const timeoutMs =
		typeof request.timeoutMs === "number" && Number.isFinite(request.timeoutMs) ? request.timeoutMs : undefined;
	const { definition, capabilities } = resolveAdmittedDefinition(options, agentType);
	const workspace = request.workspace ?? { isolation: "shared-read", ownedPaths: [] };
	// The owner is read only for worktree isolation, so production callers can
	// construct it lazily: a shared-read delegation never builds an owner and
	// never invokes git.
	const workspaceOwner = workspace.isolation === "worktree" ? options.workspaceOwner : undefined;
	if (workspace.isolation === "worktree" && !workspaceOwner) {
		throw new Error(
			`Delegation to agent "${agentType}" requested worktree isolation, but no workspace owner is available.`,
		);
	}
	const claims = [...workspace.ownedPaths].map((p) => resolve(p));
	for (const entry of registry.activeWorkspaceClaims()) {
		if (claims.some((path) => claimPathsOverlap(path, entry))) {
			throw new Error(`Delegation to agent "${agentType}" overlaps an active write ownership claim.`);
		}
	}

	// The depth bound and capability ceiling are enforced inside
	// resolveAdmittedDefinition above, shared with historical reattachment.
	// The caller may provide the public handle so the registry identity and
	// child session identity cannot diverge. Existing callers retain generated IDs.
	const sessionId = request.handleId ?? randomUUID();
	const depth = options.getDelegationDepth();
	registry.claimWorkspace(sessionId, claims);
	if (workspaceOwner) {
		// Worktree isolation: the registry releases this workspace when the run
		// closes or the registry disposes, through the same owner.
		registry.setWorkspaceOwner(workspaceOwner);
		registry.trackWorkspace(sessionId);
	}
	try {
		// Concurrency admission (spec 2026-09-09, "Shared budgets"): over the
		// limit this throws BEFORE any child session is built, naming the limit.
		registry.admitChildRun(sessionId);
		const preparedWorkspace = workspaceOwner
			? await workspaceOwner.prepare({ ...workspace, ownedPaths: claims, sessionId })
			: workspace;
		let artifactDir: string | undefined;
		const parentSessionDir = options.getParentSessionDir?.();
		if (parentSessionDir) {
			const parentRoot = resolve(parentSessionDir);
			artifactDir = join(parentRoot, "delegations", sessionId);
			mkdirSync(artifactDir, { recursive: true });
		}
		const child = await options.buildChildSession({
			agentType,
			definition,
			toolNames: definition.tools,
			capabilities,
			depth: depth + 1,
			sessionId,
			artifactDir,
			workspace: preparedWorkspace,
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		});
		registry.own(child);
		const handleId = sessionId;
		const promise = child.run(task).then(({ output }) => ({ agentType, task, output }));
		// register() observes the turn's settlement: it records the handle's latest
		// result (retrieval follows that, not this promise) and persists the run's
		// terminal status, so no separate settlement hook is needed here. The
		// durable fields ride along so every save() can persist them for restart.
		// A launch is attempt 1; timeoutMs also records the wall-clock deadline the
		// pollable status observes lazily. The record linkage (policy snapshot,
		// sandbox flag, parent session id) comes from the handle's own
		// construction report -- the values buildChildSession actually used --
		// and the runtime's parent-session seam; fixture handles that omit them
		// simply leave the record fields absent.
		registry.register(handleId, {
			agentType,
			task,
			promise,
			child,
			artifactDir,
			workspace: preparedWorkspace,
			depth: depth + 1,
			attempts: [{ id: "attempt-1", startedAt: Date.now() }],
			activeAttemptId: "attempt-1",
			...(child.policy ? { policy: child.policy } : {}),
			...(options.getParentSessionId ? { parentSessionId: options.getParentSessionId() } : {}),
			...(request.idempotencyKey !== undefined ? { idempotencyKey: request.idempotencyKey } : {}),
			...(timeoutMs !== undefined ? { deadlineMs: Date.now() + timeoutMs } : {}),
		});
		if (!request.background) return promise;
		return { agentType, task, output: `Delegation started. Retrieve result with handle "${handleId}".`, handleId };
	} catch (error) {
		// The delegation never started: release the workspace immediately (also
		// marks it released, so a later close/dispose cannot double-release) and
		// give back the concurrency slot admitted above.
		registry.releaseChildRunSlot(sessionId);
		await registry.releaseWorkspaceNow(sessionId);
		throw error;
	}
}

/** Retrieve a background delegation. Running children are awaited; unknown handles fail explicitly. */
export async function retrieveDelegationResult(
	options: DelegationRuntimeOptions,
	handleId: string,
	expectedAgentType?: string,
): Promise<DelegationResult> {
	let registry = options.childRunRegistry;
	if (!registry) {
		registry = new ChildRunRegistry();
		options.childRunRegistry = registry;
	}
	return registry.retrieve(handleId, expectedAgentType);
}
