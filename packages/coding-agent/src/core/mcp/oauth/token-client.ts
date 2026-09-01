import { type FetchLike, oauthErrorMessage } from "./discover.ts";

export class TokenEndpointError extends Error {
	/** The OAuth `error` code from the response body, when the server sent one (e.g. invalid_grant). */
	code: string | undefined;

	constructor(message: string, code: string | undefined) {
		super(message);
		this.code = code;
	}
}

/** The endpoint could not be reached at all — a path problem, not a server refusal. */
export class TokenEndpointUnreachableError extends TokenEndpointError {}

export interface TokenResponse {
	accessToken: string;
	/** Absent when the server did not rotate; callers keep their previous refresh token then. */
	refreshToken: string | undefined;
	expiresInSeconds: number;
}

interface TokenEndpointOptions {
	tokenEndpoint: URL;
	clientId: string;
	clientSecret?: string;
	/** The MCP resource indicator; pins the issued token to this server (RFC 8707). */
	resource?: string;
	fetch?: FetchLike;
}

async function postTokenForm(options: TokenEndpointOptions, grant: Record<string, string>): Promise<TokenResponse> {
	const fetch = options.fetch ?? globalThis.fetch;
	const body = new URLSearchParams({ client_id: options.clientId, ...grant });
	if (options.clientSecret) body.set("client_secret", options.clientSecret);
	if (options.resource) body.set("resource", options.resource);

	let response: Response;
	try {
		response = await fetch(options.tokenEndpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});
	} catch (error) {
		throw new TokenEndpointUnreachableError(
			`token endpoint unreachable at ${options.tokenEndpoint}: ${oauthErrorMessage(error)}`,
			undefined,
		);
	}

	const text = await response.text();
	let parsed: Record<string, unknown> = {};
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value === "object" && value !== null) parsed = value as Record<string, unknown>;
	} catch {
		// A non-JSON error body still lands in the status branch below.
	}
	if (!response.ok) {
		const code = typeof parsed.error === "string" ? parsed.error : undefined;
		throw new TokenEndpointError(`token endpoint answered HTTP ${response.status}${code ? ` (${code})` : ""}`, code);
	}
	if (typeof parsed.access_token !== "string" || typeof parsed.expires_in !== "number") {
		throw new TokenEndpointError("token endpoint response is missing access_token or expires_in", undefined);
	}
	return {
		accessToken: parsed.access_token,
		refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined,
		expiresInSeconds: parsed.expires_in,
	};
}

export function exchangeAuthorizationCode(
	options: TokenEndpointOptions & { code: string; verifier: string; redirectUri: string },
): Promise<TokenResponse> {
	return postTokenForm(options, {
		grant_type: "authorization_code",
		code: options.code,
		code_verifier: options.verifier,
		redirect_uri: options.redirectUri,
	});
}

export function refreshAccessToken(options: TokenEndpointOptions & { refreshToken: string }): Promise<TokenResponse> {
	return postTokenForm(options, { grant_type: "refresh_token", refresh_token: options.refreshToken });
}
