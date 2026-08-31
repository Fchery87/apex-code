/**
 * Declarative hooks (spec 2026-08-31-declarative-hooks): a settings-file path
 * onto the extension event catalog, for operators who will never author a
 * TypeScript extension. Version one maps five events onto command and HTTP
 * handlers, with decisions read only from `tool_call`.
 *
 * The decision vocabulary is restriction-only: `block` short-circuits, `ask`
 * defers to the permission gate, and `allow` is recorded but never bypasses
 * the gate. A hook can narrow what runs, never widen it -- which is what makes
 * trust-gated project-scope hooks safe where project-sandbox profiles are not
 * (ADR 0016).
 */

export const HOOK_EVENT_NAMES = [
	"tool_call",
	"tool_result",
	"session_start",
	"turn_end",
	"session_before_compact",
] as const;
export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

export interface HookCommandHandlerConfig {
	type: "command";
	/** Tool-name exact or `|`/`,`-separated list; absent matches every tool. Only consulted for events that carry a tool name. */
	matcher?: string;
	/** Shell command; the event payload arrives as JSON on stdin, the decision as JSON on stdout. */
	command: string;
	/** Default 10s (DEFAULT_HOOK_TIMEOUT_MS). A handler that outlives its timeout fails closed on `tool_call`. */
	timeoutMs?: number;
}

export interface HookHttpHandlerConfig {
	type: "http";
	matcher?: string;
	/** The event payload is POSTed here; the decision is read from the 200 response body. URLs come from settings only -- never environment interpolation. */
	url: string;
	timeoutMs?: number;
}

export type HookHandlerConfig = HookCommandHandlerConfig | HookHttpHandlerConfig;

export type HooksSettings = Partial<Record<HookEventName, HookHandlerConfig[]>>;

export interface HookDecision {
	decision: "allow" | "block" | "ask";
	reason?: string;
}

export interface HookEventPayload {
	type: HookEventName;
	toolName?: string;
	toolCallId?: string;
	input?: unknown;
	reason?: string;
}

export type HookOutcome = { ok: true; decision?: HookDecision; warning?: string } | { ok: false; warning: string };

export interface HookHandler {
	/** Absent on a handler means it matches every tool. */
	matchesTool?(toolName: string): boolean;
	execute(payload: HookEventPayload): Promise<HookOutcome>;
}

/** What a `tool_call` hook hands back to the session: the same shape the beforeToolCall seam already consumes. */
export interface HookToolCallBlock {
	block: true;
	reason: string;
}

export interface HookRuntime {
	hasHandlers(event: HookEventName): boolean;
	/** Test and diagnostic accessor; the runtime never mutates the handlers it holds. */
	handlersFor(event: HookEventName): readonly HookHandler[];
	/**
	 * `tool_call` decisions, restriction-only: `block` returns a block for the
	 * seam to consume, every other outcome (allow, ask, no decision) returns
	 * undefined so the permission gate still evaluates the call. A handler that
	 * fails or times out fails closed.
	 */
	decideToolCall(toolName: string, payload: HookEventPayload): Promise<HookToolCallBlock | undefined>;
	/**
	 * Observe-only emission for `tool_result` and lifecycle events: handlers are
	 * awaited in order, failures are swallowed, and no decision is ever read.
	 */
	emitObserve(event: HookEventName, payload: HookEventPayload): Promise<void>;
}

/** Default per-handler timeout. A hung formatter must not stall the loop indefinitely. */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
/** Hard cap on configured timeouts. */
export const MAX_HOOK_TIMEOUT_MS = 60_000;
