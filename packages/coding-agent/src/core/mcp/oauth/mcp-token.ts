/**
 * The MCP credential seam: how an MCP server's OAuth token is keyed, read, and
 * refreshed through the session's existing `CredentialStore`.
 *
 * Which store instance that is depends on where the session runs. On the host it is
 * `AuthStorage` (direct, lock-serialized writes); in a sandboxed child it is
 * `SandboxAuthStorage` (reads from the read-only projection, writes through the
 * supervisor-mediated channel, ADR 0015). A session with neither has a read-only
 * store whose `modify` throws, which is the fail-closed path: refresh never
 * silently degrades to "pretend it worked".
 */

import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { McpServerConfig } from "../types.ts";
import { discoverAuthorizationServer, type FetchLike, oauthErrorMessage } from "./discover.ts";
import {
	refreshAccessToken,
	TokenEndpointError,
	TokenEndpointUnreachableError,
	type TokenResponse,
} from "./token-client.ts";

/** Refresh this long before expiry so an in-flight call never rides a dying token. */
const REFRESH_SKEW_MS = 60_000;

export function mcpCredentialKey(serverName: string): string {
	return `mcp/${serverName}`;
}

/** Extra fields carried on the `OAuthCredential` index signature, written by the flow. */
interface McpTokenExtras {
	tokenEndpoint?: string;
	resource?: string;
	clientId?: string;
}

export interface StoredServerToken {
	accessToken: string;
	/** Empty when the server issued no refresh token; refresh is impossible then. */
	refreshToken: string;
	expiresAt: number;
	extras: McpTokenExtras;
}

export class McpOAuthRequiredError extends Error {}

export class McpOAuthRefreshError extends Error {
	/** "refused": the server said no; "unavailable": the path to the store or network failed. */
	stage: "refused" | "unavailable";

	constructor(message: string, stage: "refused" | "unavailable") {
		super(message);
		this.stage = stage;
	}
}

export function authRequired(serverName: string): McpOAuthRequiredError {
	return new McpOAuthRequiredError(
		`MCP server "${serverName}" requires OAuth and has no stored authorization. Run \`apex-code mcp auth ${serverName}\` to authorize it, then retry.`,
	);
}

function extrasOf(credential: Credential): McpTokenExtras {
	if (credential.type !== "oauth") return {};
	const extras: McpTokenExtras = {};
	if (typeof credential.tokenEndpoint === "string") extras.tokenEndpoint = credential.tokenEndpoint;
	if (typeof credential.resource === "string") extras.resource = credential.resource;
	if (typeof credential.clientId === "string") extras.clientId = credential.clientId;
	return extras;
}

function toStoredToken(credential: Credential): StoredServerToken | undefined {
	if (credential.type !== "oauth") return undefined;
	return {
		accessToken: credential.access,
		refreshToken: credential.refresh,
		expiresAt: credential.expires,
		extras: extrasOf(credential),
	};
}

export async function readServerToken(
	credentials: CredentialStore,
	serverName: string,
): Promise<StoredServerToken | undefined> {
	const credential: Credential | undefined = await credentials.read(mcpCredentialKey(serverName));
	return credential ? toStoredToken(credential) : undefined;
}

/**
 * Returns a current access token for the server, refreshing first when the stored one
 * is at the edge of expiry. Throws `McpOAuthRequiredError` when nothing is stored and
 * `McpOAuthRefreshError` when a refresh cannot be completed; both name the auth
 * command in their message.
 */
export async function ensureFreshServerToken(options: {
	server: McpServerConfig;
	credentials: CredentialStore;
	now?: () => number;
	fetch?: FetchLike;
}): Promise<string> {
	const { server, credentials } = options;
	const now = options.now ?? Date.now;
	const serverName = server.name;
	const stored = await readServerToken(credentials, serverName);
	if (!stored) throw authRequired(serverName);
	if (stored.expiresAt - REFRESH_SKEW_MS > now()) return stored.accessToken;
	if (!stored.refreshToken) {
		throw new McpOAuthRefreshError(
			`MCP server "${serverName}" authorization has expired and no refresh token was issued. Run \`apex-code mcp auth ${serverName}\` to authorize it again.`,
			"refused",
		);
	}
	if (server.transport.kind !== "http") {
		throw new McpOAuthRefreshError(
			`MCP server "${serverName}" is not an HTTP server; run \`apex-code mcp auth ${serverName}\`.`,
			"refused",
		);
	}
	const resource = stored.extras.resource ?? server.transport.url;

	let tokenEndpoint = stored.extras.tokenEndpoint;
	if (!tokenEndpoint) {
		const metadata = await discoverAuthorizationServer({ serverUrl: server.transport.url, fetch: options.fetch });
		tokenEndpoint = metadata.tokenEndpoint;
	}

	let refreshed: TokenResponse;
	try {
		refreshed = await refreshAccessToken({
			tokenEndpoint: new URL(tokenEndpoint),
			refreshToken: stored.refreshToken,
			clientId: stored.extras.clientId ?? `apex-code-mcp-${serverName}`,
			resource,
			fetch: options.fetch,
		});
	} catch (error) {
		if (error instanceof TokenEndpointError && error.code === "invalid_grant") {
			throw new McpOAuthRefreshError(
				`MCP server "${serverName}" rejected its refresh token. Run \`apex-code mcp auth ${serverName}\` to authorize it again.`,
				"refused",
			);
		}
		if (error instanceof TokenEndpointUnreachableError) {
			throw new McpOAuthRefreshError(`MCP server "${serverName}" refresh failed: ${error.message}`, "unavailable");
		}
		if (error instanceof TokenEndpointError) {
			throw new McpOAuthRefreshError(`MCP server "${serverName}" refresh failed: ${error.message}`, "refused");
		}
		throw new McpOAuthRefreshError(
			`MCP server "${serverName}" refresh failed: ${oauthErrorMessage(error)}`,
			"unavailable",
		);
	}

	const expiresAt = now() + refreshed.expiresInSeconds * 1000 - REFRESH_SKEW_MS;
	const credential: Credential = {
		type: "oauth",
		access: refreshed.accessToken,
		// No rotation: keep the refresh token the server still honors.
		refresh: refreshed.refreshToken ?? stored.refreshToken,
		expires: expiresAt,
		tokenEndpoint,
		resource,
		clientId: stored.extras.clientId,
	};
	try {
		await credentials.modify(mcpCredentialKey(serverName), async () => credential);
	} catch (error) {
		// The fresh access token works for this connection, but the store could not
		// record the rotation — for a sandboxed child, that is the channel refusing.
		// Fail this call closed rather than run ahead of what the store knows.
		throw new McpOAuthRefreshError(
			`MCP server "${serverName}" was refreshed but the session cannot store the new token: ${oauthErrorMessage(error)}`,
			"unavailable",
		);
	}
	return refreshed.accessToken;
}
