/**
 * Shared entry point for `apex-code mcp auth <server>` and the TUI `/mcp auth`
 * command. Resolves the named server from the merged MCP config, checks it is an
 * OAuth-configured HTTP server, and runs the flow. UI-agnostic: callers supply the
 * line printer and the browser opener.
 */

import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../auth-storage.ts";
import { loadMcpConfig, PROJECT_CONFIG_FILENAME } from "../config.ts";
import { runMcpOAuthFlow } from "./flow.ts";

export interface AuthorizeServerOptions {
	serverName: string;
	/** Project root for `.mcp.json` discovery. Default: process.cwd(). */
	cwd?: string;
	/** Credential sink. Default: the host store (`AuthStorage.create()`). */
	credentials?: CredentialStore;
	openBrowser?: (url: string) => void;
	/** Injectable flow, for tests. */
	flow?: typeof runMcpOAuthFlow;
	log: (line: string) => void;
}

export async function authorizeConfiguredServer(options: AuthorizeServerOptions): Promise<void> {
	const { servers } = loadMcpConfig({ projectPath: join(options.cwd ?? process.cwd(), PROJECT_CONFIG_FILENAME) });
	const server = servers.get(options.serverName);
	if (!server) {
		const names = [...servers.keys()];
		throw new Error(
			`MCP server "${options.serverName}" is not configured. Configured servers: ${names.join(", ") || "none"}. Add it to .mcp.json first.`,
		);
	}
	if (server.transport.kind !== "http") {
		throw new Error(`MCP server "${options.serverName}" is a stdio server; OAuth applies to HTTP servers only.`);
	}
	if (server.auth !== "oauth") {
		throw new Error(
			`MCP server "${options.serverName}" is not configured for OAuth. Add "auth": "oauth" to its entry.`,
		);
	}
	const result = await (options.flow ?? runMcpOAuthFlow)({
		serverName: options.serverName,
		serverUrl: server.transport.url,
		credentials: options.credentials ?? AuthStorage.create(),
		deps: { print: options.log, openBrowser: options.openBrowser ?? (() => {}) },
	});
	options.log(
		`Authorized "${options.serverName}". Token stored; expires ${new Date(result.expiresAt).toISOString()}.`,
	);
}
