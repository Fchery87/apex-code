/**
 * Core MCP data shapes. Settled before any logic consumes them, per the plan's U1:
 * a late change to `ServerState` or `CachedTool` is a rewrite of the server manager
 * and the proxy tool, where an early one is a one-line diff.
 */

import type { Capability } from "../tools/contract.ts";

/**
 * How to reach a server. Inferred from which fields the config entry carries, never
 * declared: every MCP host writes `command` for stdio and `url` for HTTP, and none
 * writes a `transport` field, so requiring one would reject the config files users
 * already have.
 */
export type McpTransport =
	| {
			kind: "stdio";
			command: string;
			args: string[];
			env: Record<string, string>;
			cwd: string | undefined;
	  }
	| {
			kind: "http";
			url: string;
			headers: Record<string, string>;
			/** Environment variable holding a bearer token. OAuth is a spec non-goal (ADR 0015). */
			bearerTokenEnv: string | undefined;
	  };

export type McpLifecycle = "lazy" | "eager" | "keep-alive" | "lazy-keep-alive";

export const DEFAULT_LIFECYCLE: McpLifecycle = "lazy";
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;

/**
 * A server's declared authority, and the only place it is stated. The capability set
 * feeds the tool contract every tool on this server projects (ADR 0010), which is why
 * an absent set resolves to the full one rather than the empty one.
 */
export interface McpServerConfig {
	name: string;
	transport: McpTransport;
	capabilities: ReadonlySet<Capability>;
	lifecycle: McpLifecycle;
	idleTimeoutMinutes: number;
}

/**
 * Connection state. A union rather than a `connected` boolean beside a `lastError`
 * string, so a state cannot carry data that is invalid for it.
 */
export type ServerState =
	| { kind: "disconnected" }
	| { kind: "connecting"; since: number }
	| { kind: "ready"; since: number; lastUsed: number }
	| { kind: "failed"; error: string; failedAt: number; retryAfter: number };

/**
 * What the disk cache holds. Everything here is producible without a live connection,
 * which is the property that lets search and describe answer with no server running.
 */
export interface CachedTool {
	server: string;
	name: string;
	description: string;
	inputSchema: unknown;
}

/** A config problem that dropped an entry or fell back to a default. Never thrown. */
export interface McpConfigDiagnostic {
	path: string;
	server: string | undefined;
	message: string;
}

export interface McpConfig {
	servers: ReadonlyMap<string, McpServerConfig>;
	diagnostics: readonly McpConfigDiagnostic[];
}
