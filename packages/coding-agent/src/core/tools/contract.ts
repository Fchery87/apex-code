/**
 * The canonical tool contract. Settled by ADR 0010 and specified in full at
 * docs/architecture/contracts.md § 1 — this module implements that shape, it does
 * not redesign it. `contract` is required on every registered tool, and so is every
 * sub-field: a tool cannot compile without answering all four axes (capabilities,
 * permission, context, evidence), which is what keeps a new tool from silently
 * defaulting into "unclassified".
 */

import type { AgentToolResult } from "apex-code-agent-core";
import type { Static, TSchema } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

/** What class of thing a tool does. A set, not a single value — `bash` is `{exec}`. */
export type Capability = "fs.read" | "fs.write" | "exec" | "net" | "delegate" | "ui" | "state";

export const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
	"fs.read",
	"fs.write",
	"exec",
	"net",
	"delegate",
	"ui",
	"state",
]);

export type PermissionBehavior = "allow" | "deny" | "ask";

/**
 * `ruleContent` is interpreted by the tool, never by the rule engine (ADR 0010).
 * That is what lets `Bash(git commit:*)` and `Read(~/.ssh/**)` mean entirely
 * different things while the engine that resolves precedence stays tool-agnostic.
 */
export interface PermissionSpec<TParams extends TSchema = TSchema> {
	/** Behavior when no rule matches. Read-only tools may default to "allow". */
	defaultBehavior: PermissionBehavior;

	/**
	 * Per-call behavior when no rule matches, for tools whose calls differ in
	 * nature (bash: launching a command is "ask", retrieving or killing an
	 * already-approved background command is "allow"). Return undefined to fall
	 * back to `defaultBehavior`. Floors and matching rules still outrank it --
	 * this only replaces the fallthrough, never a rule or a mode floor.
	 */
	defaultBehaviorFor?(params: Static<TParams>): PermissionBehavior | undefined;

	/** Does this call match this rule's content? The tool owns the grammar. */
	matches(ruleContent: string, params: Static<TParams>): boolean;

	/** Human-readable rendering of a rule, for prompts and denial messages. */
	describe(ruleContent: string): string;

	/**
	 * The rule that would allow this exact call — what "always allow this"
	 * persists. Return null when the call is not generalizable into a rule.
	 */
	ruleForCall(params: Static<TParams>): string | null;
}

export interface ContextSpec {
	/**
	 * True when the result's information is recoverable — the same content can be
	 * obtained again by re-running the tool or reading the workspace.
	 *
	 * ONLY recoverable results may be evicted (Phase 3). A tool whose result cannot
	 * be regenerated (a nondeterministic command, a consumed one-shot resource)
	 * must set this false, or eviction would silently destroy information the
	 * transcript is the only record of.
	 */
	resultRecoverable: boolean;

	/** Marker substituted for an evicted result. */
	evictionMarker?: string;

	/** Announce by name only; load the parameter schema on demand. */
	deferSchema: boolean;

	/** Soft cap on result tokens before truncation. */
	outputBudgetTokens?: number;
}

export type EvidenceKind = "diff" | "test" | "command" | "manual" | "workflow" | "diagnostic";

/** Source-observed command facts. `exitCode` is absent only when execution never began. */
export interface CommandEvidenceRecord {
	kind: "command";
	command: string;
	cwd?: string;
	executable?: string;
	argv?: string[];
	exitCode?: number | null;
}

/** A file mutation is identified by hashes and paths, never raw file or patch contents. */
export interface DiffEvidenceRecord {
	kind: "diff";
	path: string;
	patchHash?: string;
	contentHash?: string;
	byteCount?: number;
}

/** Zero-filled diagnostic severity buckets for one bounded language-server outcome. */
export interface DiagnosticSeverityCounts {
	error: number;
	warning: number;
	information: number;
	hint: number;
	unspecified: number;
	other: number;
}

/** Stable durable classification. Free-form server and process errors never enter evidence. */
export type DiagnosticUnavailableKind =
	| "no-server"
	| "disposed"
	| "unsupported-sync"
	| "timed-out"
	| "aborted"
	| "superseded"
	| "server-failed";

/** Bounded post-mutation diagnostic facts, never diagnostic messages or rendered failure reasons. */
export type DiagnosticEvidenceRecord =
	| {
			kind: "diagnostic";
			path: string;
			status: "ok";
			serverId: string;
			diagnosticCount: number;
			severityCounts: DiagnosticSeverityCounts;
			truncated: boolean;
	  }
	| {
			kind: "diagnostic";
			path: string;
			status: "unavailable";
			serverId?: string;
			unavailableKind: DiagnosticUnavailableKind;
	  };

/** Normalized argv-based test execution facts. */
export interface TestEvidenceRecord {
	kind: "test";
	cwd: string;
	executable: string;
	argv: string[];
	exitCode: number | null;
}

/** Explicit human attestation; policy decides how, or whether, it is sufficient. */
export interface ManualEvidenceRecord {
	kind: "manual";
	value?: unknown;
	observed?: unknown;
	status?: string;
}

/** Source facts from approval and delegation workflows. */
export interface WorkflowEvidenceRecord {
	kind: "workflow";
	plan?: string;
	approved?: boolean;
	agentType?: string;
	task?: string;
	handle?: string;
}

/** A structured source record. Policy is a separate consumer, not an additional variant. */
export type EvidenceRecord =
	| CommandEvidenceRecord
	| DiffEvidenceRecord
	| DiagnosticEvidenceRecord
	| TestEvidenceRecord
	| ManualEvidenceRecord
	| WorkflowEvidenceRecord;

/** Durable destination for source-level tool evidence. Policy is deliberately not part of this boundary. */
export interface EvidenceSink {
	record(entry: { toolName: string; records: EvidenceRecord[] }): void;
	recordDiagnostic?(diagnostic: EvidenceCaptureDiagnostic): void;
}

/** A capture failure is observable but never changes an already-completed tool result. */
export interface EvidenceCaptureDiagnostic {
	toolName: string;
	reason: string;
}

export interface EvidenceSpec<TParams extends TSchema = TSchema, TDetails = unknown> {
	/** Kinds this tool can emit. Empty set is valid and explicit. */
	emits: ReadonlySet<EvidenceKind>;

	/**
	 * Derive evidence from a completed call. Runs inside the tool's own execution
	 * path, with access to what actually happened, not a reconstruction from
	 * rendered output.
	 */
	capture(params: Static<TParams>, result: AgentToolResult<TDetails>): EvidenceRecord[];
}

export interface ToolContract<TParams extends TSchema = TSchema, TDetails = unknown> {
	capabilities: ReadonlySet<Capability>;
	permission: PermissionSpec<TParams>;
	context: ContextSpec;
	evidence: EvidenceSpec<TParams, TDetails>;
}

/**
 * Apex Code extends upstream ToolDefinition with exactly one required field.
 *
 * `TState` defaults to `any`, matching upstream `ToolDefinition` exactly (not
 * `unknown`). That default is load-bearing: TypeScript compares two instantiations
 * of the *same* generic interface (here, both rooted in `ToolDefinition`) using each
 * type parameter's declared variance, without expanding `Static<TParams>`
 * structurally — but only when every type argument lines up, including the ones a
 * caller left defaulted. A mismatched default reintroduces a full structural check,
 * where `Static<any>` does not behave like `any`, and breaks every pre-existing
 * `ToolDefinition<any, X>`-typed consumer across the codebase.
 */
export interface ApexToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>
	extends ToolDefinition<TParams, TDetails, TState> {
	contract: ToolContract<TParams, TDetails>;
}

/**
 * Conservative contract for a tool registered without one -- third-party extension
 * tools, which cannot supply a `contract`. MCP tools no longer land here: they reach
 * the model through the built-in `mcp` proxy, whose contract is declared in
 * `core/mcp/contract.ts`. Full capability set (so it can
 * never widen a delegation ceiling), `ask` by default, never evicted, schema
 * deferred, emits nothing. Matching is exact-argument only: a foreign tool's rule
 * authorizes exactly the call it was generated from, never a pattern.
 *
 * This must also be reported as unclassified wherever a consumer describes the tool
 * registry (contracts.md invariant 1) — a conservative default nobody can see is
 * indistinguishable from a bug.
 */
export const UNCLASSIFIED: ToolContract<TSchema, unknown> = {
	capabilities: ALL_CAPABILITIES,
	permission: {
		defaultBehavior: "ask",
		matches: (ruleContent, params) => ruleContent === JSON.stringify(params),
		describe: (ruleContent) => `Exact call: ${ruleContent}`,
		ruleForCall: (params) => JSON.stringify(params),
	},
	context: { resultRecoverable: false, deferSchema: false },
	evidence: { emits: new Set(), capture: () => [] },
};

/** Resolve a complete tool contract for enforcement consumers. */
export function resolveToolContract(
	lookup: (toolName: string) => ToolContract | undefined,
	toolName: string,
): ToolContract {
	return lookup(toolName) ?? UNCLASSIFIED;
}

/** Resolve the context projection using the same canonical foreign-tool fallback. */
export function resolveToolContext(
	lookup: (toolName: string) => Pick<ToolContract, "context"> | undefined,
	toolName: string,
): Pick<ToolContract, "context"> {
	return lookup(toolName) ?? UNCLASSIFIED;
}
