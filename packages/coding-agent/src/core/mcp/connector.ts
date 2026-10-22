/**
 * The MCP SDK lives here and nowhere else.
 *
 * Everything above this file talks to `McpConnection`, so the lifecycle logic, the
 * proxy tool, and their tests never import the SDK or start a process. This module is
 * the boundary where an external protocol becomes an internal type.
 */

import { chmodSync, createWriteStream, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Stream } from "node:stream";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { APP_NAME, getAgentDir, VERSION } from "../../config.ts";
import { resolveConfigValue } from "../resolve-config-value.ts";
import type { FetchLike } from "./oauth/discover.ts";
import { authRequired, ensureFreshServerToken } from "./oauth/mcp-token.ts";
import type { CachedTool, McpCallResult, McpConnection, McpConnector, McpServerConfig } from "./types.ts";

/**
 * Authorization for one HTTP connection, in precedence order: a static configured
 * header, then a named bearer env var, then the credential store's OAuth token.
 * Later wins, because each later source is the more deliberately configured one.
 */
export function resolveAuthorizationHeaders(
	server: McpServerConfig,
	oauthAuthorization?: string,
): Record<string, string> {
	if (server.transport.kind !== "http") return {};
	const headers = { ...server.transport.headers };
	const token = server.transport.bearerTokenEnv ? process.env[server.transport.bearerTokenEnv] : undefined;
	if (token) headers.Authorization = `Bearer ${token}`;
	if (oauthAuthorization) headers.Authorization = oauthAuthorization;
	return headers;
}

/**
 * The environment a stdio server starts with: the SDK's safe default set (PATH, locale,
 * and the like), then the entry's own `env` with each value resolved through the same
 * `$VAR` / `${VAR}` / `$$` syntax provider keys use. A server does not inherit the rest of
 * the parent's environment, so a provider key in the shell never reaches a third-party
 * process. A reference to an unset variable is omitted, and the connect-failure hint says
 * how to reference one.
 */
export function buildStdioEnvironment(configured: Record<string, string>): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [name, value] of Object.entries(configured)) {
		const resolvedValue = resolveConfigValue(value);
		if (resolvedValue !== undefined) resolved[name] = resolvedValue;
	}
	return { ...getDefaultEnvironment(), ...resolved };
}

/** One server's diagnostics stay bounded. Past this, later bytes are dropped. */
const STDERR_LOG_LIMIT = 1024 * 1024;

/**
 * A stdio server's stderr is its own diagnostics channel. Inherited, it writes straight
 * onto the terminal the TUI is drawing on and corrupts the screen, so it goes to a
 * per-server log under the agent directory instead. The log stops at
 * {@link STDERR_LOG_LIMIT}; the server keeps running either way.
 */
function keepStderrInLog(serverName: string, stderr: Stream): void {
	const drop = () => {
		const source = stderr as NodeJS.EventEmitter & { resume?: () => void };
		if (typeof source.resume === "function") source.resume();
		else source.on("data", () => {});
	};
	const logDir = join(getAgentDir(), "mcp", "logs");
	try {
		mkdirSync(logDir, { recursive: true, mode: 0o700 });
		chmodSync(logDir, 0o700);
		const logPath = join(logDir, `${serverName.replace(/[^A-Za-z0-9._-]/g, "_")}.log`);
		let written = 0;
		try {
			written = statSync(logPath).size;
		} catch {
			written = 0;
		}
		if (written >= STDERR_LOG_LIMIT) {
			drop();
			return;
		}
		const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
		log.on("error", drop);
		log.on("open", () => {
			try {
				chmodSync(logPath, 0o600);
			} catch {
				// An existing file we cannot tighten still receives the stream.
			}
		});
		stderr.on("data", (chunk: Buffer | string) => {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			if (written >= STDERR_LOG_LIMIT) return;
			const room = STDERR_LOG_LIMIT - written;
			log.write(bytes.length <= room ? bytes : bytes.subarray(0, room));
			written += Math.min(bytes.length, room);
		});
	} catch {
		// Logging must not stop the server. Drop the diagnostics rather than
		// letting them reach the terminal.
		drop();
	}
}

function createTransport(server: McpServerConfig, oauthAuthorization?: string) {
	if (server.transport.kind === "stdio") {
		return new StdioClientTransport({
			command: server.transport.command,
			args: server.transport.args,
			env: buildStdioEnvironment(server.transport.env),
			cwd: server.transport.cwd,
			stderr: "pipe",
		});
	}

	return new StreamableHTTPClientTransport(new URL(server.transport.url), {
		requestInit: { headers: resolveAuthorizationHeaders(server, oauthAuthorization) },
	});
}

/**
 * Server content arrives as a heterogeneous array. Only text is carried forward; an
 * image or an embedded resource is named rather than dropped silently, so a caller
 * can tell the difference between "returned nothing" and "returned something we do
 * not render yet".
 */
function toCallResult(raw: unknown): McpCallResult {
	const result = raw as { content?: unknown; isError?: unknown };
	const parts = Array.isArray(result?.content) ? result.content : [];
	const content = parts.map((part) => {
		const item = part as { type?: unknown; text?: unknown };
		if (item?.type === "text" && typeof item.text === "string") {
			return { type: "text" as const, text: item.text };
		}
		return { type: "text" as const, text: `[${String(item?.type ?? "unknown")} content omitted]` };
	});

	return {
		content: content.length > 0 ? content : [{ type: "text" as const, text: "(no content)" }],
		isError: result?.isError === true,
	};
}

export async function connectMcpServer(server: McpServerConfig, oauthAuthorization?: string): Promise<McpConnection> {
	const client = new Client({ name: APP_NAME, version: VERSION });
	const transport = createTransport(server, oauthAuthorization);
	if (transport instanceof StdioClientTransport && transport.stderr) keepStderrInLog(server.name, transport.stderr);
	try {
		await client.connect(transport);
	} catch (error) {
		if (server.transport.kind !== "stdio") throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${message}. The server starts with only its safe default environment. To pass a variable from yours, reference it in the server's env entry as "NAME": "$NAME".`,
		);
	}

	return {
		async listTools(): Promise<CachedTool[]> {
			const { tools } = await client.listTools();
			return tools.map((tool) => ({
				server: server.name,
				name: tool.name,
				description: tool.description ?? "",
				inputSchema: tool.inputSchema,
			}));
		},
		async callTool(name: string, args: unknown): Promise<McpCallResult> {
			return toCallResult(await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }));
		},
		async close(): Promise<void> {
			await client.close();
		},
	};
}

export interface SessionMcpConnectorOptions {
	/**
	 * The session's credential store, `AuthStorage` by default. OAuth-configured
	 * servers without one fail closed.
	 */
	credentials?: CredentialStore;
	now?: () => number;
	fetch?: FetchLike;
}

/**
 * The session connector: resolves OAuth tokens for servers configured with
 * `auth: "oauth"`, and behaves exactly like `connectMcpServer` for everything else.
 * A missing authorization throws before the transport is constructed, so no OAuth
 * endpoint is ever contacted from a tool call path (spec 2026-09-01-mcp-oauth).
 */
export function createSessionMcpConnector(options: SessionMcpConnectorOptions = {}): McpConnector {
	return async (server) => {
		if (server.transport.kind === "http" && server.auth === "oauth") {
			if (!options.credentials) throw authRequired(server.name);
			const accessToken = await ensureFreshServerToken({
				server,
				credentials: options.credentials,
				now: options.now,
				fetch: options.fetch,
			});
			return connectMcpServer(server, `Bearer ${accessToken}`);
		}
		return connectMcpServer(server);
	};
}
