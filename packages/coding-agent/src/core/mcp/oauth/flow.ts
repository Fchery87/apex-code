/**
 * The user-initiated OAuth authorization flow for one MCP server: authorization-code
 * with PKCE against a loopback callback listener that exists only for the duration of
 * the flow. Per ADR 0023's posture, nothing here is reachable from a tool call — the
 * command is the only entry point.
 */

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { discoverAuthorizationServer, type FetchLike, OAuthDiscoveryError, oauthErrorMessage } from "./discover.ts";
import { mcpCredentialKey } from "./mcp-token.ts";
import { createPkcePair } from "./pkce.ts";
import { registerClient } from "./register.ts";
import { exchangeAuthorizationCode, TokenEndpointError } from "./token-client.ts";

export class OAuthFlowError extends Error {}

export interface McpOAuthFlowDeps {
	print: (line: string) => void;
	openBrowser: (url: string) => void;
	fetch: FetchLike;
	now: () => number;
	timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** Store the token as expiring a minute early, so in-flight calls never ride it to death. */
const EXPIRY_SKEW_MS = 60_000;
const CALLBACK_PATH = "/callback";

export interface McpOAuthFlowOptions {
	serverName: string;
	serverUrl: string;
	credentials: CredentialStore;
	/** A manually registered client id; skips dynamic registration when present. */
	clientId?: string;
	clientSecret?: string;
	deps?: Partial<McpOAuthFlowDeps>;
}

export interface McpOAuthFlowResult {
	expiresAt: number;
}

/**
 * Accepts exactly one callback carrying the issued `state`, then stops. A request with
 * the wrong state is answered 400 and the listener stays available for the real one;
 * after the right one, the socket is closed before the flow proceeds to the exchange.
 */
class LoopbackCallback {
	readonly state = randomBytes(16).toString("base64url");
	redirectUri = "";
	private server: Server | undefined;
	private resolveCode: ((code: string) => void) | undefined;

	async start(): Promise<void> {
		const server = createServer((request, response) => this.handle(request, response));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new OAuthFlowError("could not bind the loopback callback listener");
		}
		this.server = server;
		this.redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
	}

	private handle(request: IncomingMessage, response: ServerResponse): void {
		const respond = (status: number, body: string) => {
			response.writeHead(status, { "content-type": "text/plain" });
			response.end(body);
		};
		const port = this.server?.address();
		const origin = `http://127.0.0.1:${port !== null && typeof port === "object" ? port.port : 0}`;
		const url = new URL(String(request.url), origin);
		if (url.pathname !== CALLBACK_PATH) {
			respond(404, "not found");
			return;
		}
		if (url.searchParams.get("state") !== this.state) {
			respond(400, "invalid state");
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			respond(400, "missing code");
			return;
		}
		respond(200, "Authorization complete. You can close this tab.");
		const resolve = this.resolveCode;
		this.resolveCode = undefined;
		resolve?.(code);
	}

	/** Resolves with the authorization code, or rejects when the flow times out. */
	code(timeoutMs: number): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new OAuthFlowError(`timed out after ${timeoutMs} ms waiting for authorization to complete`));
			}, timeoutMs);
			this.resolveCode = (code) => {
				clearTimeout(timer);
				resolve(code);
			};
		});
	}

	close(): Promise<void> {
		const server = this.server;
		if (!server) return Promise.resolve();
		return new Promise((resolve) => server.close(() => resolve()));
	}
}

export async function runMcpOAuthFlow(options: McpOAuthFlowOptions): Promise<McpOAuthFlowResult> {
	const deps: McpOAuthFlowDeps = {
		print: options.deps?.print ?? ((line: string) => console.log(line)),
		openBrowser: options.deps?.openBrowser ?? (() => {}),
		fetch: options.deps?.fetch ?? globalThis.fetch,
		now: options.deps?.now ?? Date.now,
		timeoutMs: options.deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	};
	const callback = new LoopbackCallback();
	try {
		await callback.start();

		let wwwAuthenticate: string | undefined;
		try {
			const probe = await deps.fetch(new URL(options.serverUrl), { redirect: "error" });
			wwwAuthenticate = probe.headers.get("www-authenticate") ?? undefined;
		} catch {
			// The probe is advisory; discovery falls back to well-known URIs.
		}
		const metadata = await discoverAuthorizationServer({
			serverUrl: options.serverUrl,
			wwwAuthenticate,
			fetch: deps.fetch,
		});

		let clientId = options.clientId;
		if (!clientId) {
			if (!metadata.registrationEndpoint) {
				throw new OAuthFlowError(
					`The authorization server for "${options.serverName}" supports no dynamic client registration, so this needs manual client registration: register a client with redirect URI ${callback.redirectUri} and pass its client id.`,
				);
			}
			const registered = await registerClient({
				registrationEndpoint: new URL(metadata.registrationEndpoint),
				clientName: `Apex Code — MCP server "${options.serverName}"`,
				redirectUris: [callback.redirectUri],
				fetch: deps.fetch,
			});
			clientId = registered.clientId;
		}

		const pkce = createPkcePair();
		const authorizeUrl = new URL(metadata.authorizationEndpoint);
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("client_id", clientId);
		authorizeUrl.searchParams.set("redirect_uri", callback.redirectUri);
		authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		authorizeUrl.searchParams.set("state", callback.state);
		authorizeUrl.searchParams.set("resource", options.serverUrl);

		deps.print(`Authorize "${options.serverName}" by opening: ${authorizeUrl}`);
		try {
			deps.openBrowser(authorizeUrl.toString());
		} catch {
			// The URL is printed either way; opening a browser is best-effort.
		}

		const code = await callback.code(deps.timeoutMs);
		const token = await exchangeAuthorizationCode({
			tokenEndpoint: new URL(metadata.tokenEndpoint),
			code,
			verifier: pkce.verifier,
			redirectUri: callback.redirectUri,
			clientId,
			clientSecret: options.clientSecret,
			resource: options.serverUrl,
			fetch: deps.fetch,
		});

		const expiresAt = deps.now() + token.expiresInSeconds * 1000 - EXPIRY_SKEW_MS;
		const credential: Credential = {
			type: "oauth",
			access: token.accessToken,
			// An absent rotation keeps the refresh token the server still honors.
			refresh: token.refreshToken ?? "",
			expires: expiresAt,
			tokenEndpoint: metadata.tokenEndpoint,
			resource: options.serverUrl,
			clientId,
		};
		await options.credentials.modify(mcpCredentialKey(options.serverName), async () => credential);
		return { expiresAt };
	} catch (error) {
		if (
			error instanceof OAuthFlowError ||
			error instanceof OAuthDiscoveryError ||
			error instanceof TokenEndpointError
		) {
			throw error;
		}
		throw new OAuthFlowError(`OAuth flow for "${options.serverName}" failed: ${oauthErrorMessage(error)}`);
	} finally {
		await callback.close();
	}
}
