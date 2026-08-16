/**
 * The delegation runtime (roadmap Phase 5, ADR 0008, task 5.2). Consumes the
 * capability ceiling (ceiling.ts) and a derived permission store
 * (`../permissions/store.ts`'s `DerivedPermissionRuleStore`) to run a real child
 * agent whose authority can never exceed its parent's.
 *
 * Agent definitions and child-session construction are both injected rather than
 * built in here: agent discovery is a test fixture in this task and becomes real
 * markdown/frontmatter discovery in task 5.5 (`core/delegation/agents.ts`, not yet
 * written); child-session construction is injected so this module stays free of
 * `AgentSession`/`createAgentSession` and therefore free of the import cycle that
 * would create (`sdk.ts` already imports `agent-session.ts`).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Capability } from "../tools/contract.ts";
import { computeCapabilityCeiling } from "./ceiling.ts";

/** A delegatable agent's static configuration. Markdown + frontmatter in production (task 5.5); a plain object in tests until then. */
export interface AgentDefinition {
	name: string;
	description: string;
	/** Tool names this agent may use. Never trusted directly -- the runtime derives the actual child tool list from the computed capability set, not from this list verbatim. */
	tools: string[];
	/** Optional model id. Falls back to the parent's current model when unset or unresolvable. */
	model?: string;
	systemPrompt: string;
}

/** Resolve an agent type to its definition, or `undefined` if unknown. A plain function fixture in this task; real markdown/frontmatter discovery (task 5.5) is just a different implementation of the same shape. */
export type AgentDefinitionResolver = (agentType: string) => AgentDefinition | undefined;

/** A running or completed child, as far as the runtime needs to know. */
export interface ChildSessionHandle {
	/** Run the task to completion and return the child's final output text. */
	run(task: string): Promise<{ output: string }>;
	/** Release the child's resources. Always called, including after a failed run. */
	dispose(): void;
}

export interface BuildChildSessionRequest {
	agentType: string;
	definition: AgentDefinition;
	/** The child's tool allowlist, already ceiling-checked -- exactly `definition.tools`, never narrowed. */
	toolNames: string[];
	/** The child's own recursion depth (the parent's depth + 1), for the runtime constructing it to record on the child's session header (task 5.3). */
	depth: number;
	/** Stable id used for the child session and its artifact directory. */
	sessionId: string;
	/** Per-child artifact root, created before the child session is constructed. */
	artifactDir?: string;
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
	/** Parent session directory. When supplied, child artifacts are rooted beneath it. */
	getParentSessionDir?: () => string;
	buildChildSession: (request: BuildChildSessionRequest) => Promise<ChildSessionHandle>;
}

export interface DelegationResult {
	agentType: string;
	task: string;
	output: string;
	/** Present for background work; pass this handle to retrieveDelegationResult. */
	handleId?: string;
}

interface BackgroundDelegation {
	agentType: string;
	promise: Promise<DelegationResult>;
}

// Results deliberately stay available for the lifetime of their parent runtime.
// Phase 5 promises in-process retrieval only; restart durability belongs to Phase 6.
const backgroundByRuntime = new WeakMap<object, Map<string, BackgroundDelegation>>();

function background(options: DelegationRuntimeOptions): Map<string, BackgroundDelegation> {
	let value = backgroundByRuntime.get(options);
	if (!value) {
		value = new Map();
		backgroundByRuntime.set(options, value);
	}
	return value;
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
export async function runDelegation(
	options: DelegationRuntimeOptions,
	agentType: string,
	task: string,
	request: { background?: boolean } = {},
): Promise<DelegationResult> {
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

	const sessionId = randomUUID();
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
		depth: depth + 1,
		sessionId,
		artifactDir,
	});
	const execute = async (): Promise<DelegationResult> => {
		try {
			const { output } = await child.run(task);
			return { agentType, task, output };
		} finally {
			child.dispose();
		}
	};
	if (!request.background) return execute();
	const handleId = sessionId;
	const promise = execute();
	// Retrieval owns propagation of a child failure; mark the background promise
	// observed now so a child that fails before retrieval does not become an
	// unhandled rejection.
	void promise.catch(() => {});
	background(options).set(handleId, { agentType, promise });
	return { agentType, task, output: `Delegation started. Retrieve result with handle "${handleId}".`, handleId };
}

/** Retrieve a background delegation. Running children are awaited; unknown handles fail explicitly. */
export async function retrieveDelegationResult(
	options: DelegationRuntimeOptions,
	handleId: string,
	expectedAgentType?: string,
): Promise<DelegationResult> {
	const entry = background(options).get(handleId);
	if (!entry) throw new Error(`Unknown delegation handle "${handleId}".`);
	if (expectedAgentType !== undefined && entry.agentType !== expectedAgentType) {
		throw new Error(
			`Delegation handle "${handleId}" belongs to agent "${entry.agentType}", not "${expectedAgentType}".`,
		);
	}
	return entry.promise;
}
