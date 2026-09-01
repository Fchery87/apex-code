/**
 * OAuth discovery for MCP servers: the `WWW-Authenticate` challenge, protected-resource
 * metadata (RFC 9728), and authorization-server metadata (RFC 8414), in the order the
 * MCP authorization spec expects.
 *
 * Metadata URLs must be https. The one exception is loopback, because the authorization
 * code flow itself speaks loopback http and local development servers ride on it.
 */

export type FetchLike = typeof fetch;

export class OAuthDiscoveryError extends Error {}

export interface AuthorizationServerMetadata {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint: string | undefined;
}

const PRM_WELL_KNOWN = ".well-known/oauth-protected-resource";
const AS_WELL_KNOWN = ".well-known/oauth-authorization-server";

export function oauthErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isLoopback(url: URL): boolean {
	return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

/** Pulls `resource_metadata` out of a `WWW-Authenticate: Bearer …` challenge, if present. */
export function parseWwwAuthenticate(value: string | undefined): { resourceMetadata?: string } {
	if (!value) return {};
	const challenge = /^Bearer\s+(.*)$/i.exec(value.trim());
	if (!challenge) return {};
	const resourceMetadata = /resource_metadata\s*=\s*"([^"]+)"/i.exec(challenge[1])?.[1];
	return resourceMetadata ? { resourceMetadata } : {};
}

/** RFC 9728: the well-known URI is inserted before the path, with the bare origin as fallback. */
function wellKnownUrls(resource: URL, suffix: string): URL[] {
	const pathAware = new URL(resource);
	pathAware.pathname = `/${suffix}${resource.pathname === "/" ? "" : resource.pathname}`;
	const origin = new URL(resource);
	origin.pathname = `/${suffix}`;
	return [pathAware, origin];
}

async function fetchJson(url: URL, fetch: FetchLike): Promise<Record<string, unknown>> {
	if (url.protocol !== "https:" && !isLoopback(url)) {
		throw new OAuthDiscoveryError(`OAuth metadata URLs must be https (loopback excepted): ${url}`);
	}
	let response: Response;
	try {
		response = await fetch(url, { redirect: "error" });
	} catch (error) {
		throw new OAuthDiscoveryError(`could not fetch OAuth metadata from ${url}: ${oauthErrorMessage(error)}`);
	}
	if (!response.ok) throw new OAuthDiscoveryError(`OAuth metadata at ${url} answered HTTP ${response.status}`);
	try {
		const parsed: unknown = await response.json();
		if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
		return parsed as Record<string, unknown>;
	} catch {
		throw new OAuthDiscoveryError(`OAuth metadata at ${url} is not a JSON object`);
	}
}

function requireEndpoint(metadata: Record<string, unknown>, key: string, label: string): string {
	const value = metadata[key];
	if (typeof value !== "string" || value === "") {
		throw new OAuthDiscoveryError(`authorization server metadata is missing ${label}`);
	}
	return value;
}

function toAuthorizationServerMetadata(raw: Record<string, unknown>): AuthorizationServerMetadata {
	return {
		authorizationEndpoint: requireEndpoint(raw, "authorization_endpoint", "an authorization endpoint"),
		tokenEndpoint: requireEndpoint(raw, "token_endpoint", "a token endpoint"),
		registrationEndpoint:
			typeof raw.registration_endpoint === "string" && raw.registration_endpoint !== ""
				? raw.registration_endpoint
				: undefined,
	};
}

export async function discoverAuthorizationServer(options: {
	serverUrl: string;
	wwwAuthenticate?: string;
	fetch?: FetchLike;
}): Promise<AuthorizationServerMetadata> {
	const fetch = options.fetch ?? globalThis.fetch;
	const serverUrl = new URL(options.serverUrl);
	if (serverUrl.protocol !== "https:" && !isLoopback(serverUrl)) {
		throw new OAuthDiscoveryError(`an OAuth-protected MCP server must be https or loopback: ${options.serverUrl}`);
	}

	let authorizationServers: URL[] = [];
	const fromChallenge = parseWwwAuthenticate(options.wwwAuthenticate).resourceMetadata;
	const prmCandidates = fromChallenge ? [new URL(fromChallenge)] : wellKnownUrls(serverUrl, PRM_WELL_KNOWN);
	for (const candidate of prmCandidates) {
		try {
			const prm = await fetchJson(candidate, fetch);
			if (Array.isArray(prm.authorization_servers)) {
				authorizationServers = prm.authorization_servers
					.filter((entry): entry is string => typeof entry === "string")
					.map((entry) => new URL(entry));
				break;
			}
		} catch (error) {
			// An explicit challenge URL is the server speaking; do not silently skip it.
			if (fromChallenge !== undefined && candidate.href === fromChallenge) throw error;
		}
	}

	const asCandidates = authorizationServers.length > 0 ? authorizationServers : [serverUrl];
	let lastError: unknown;
	for (const candidate of asCandidates) {
		try {
			const wellKnown = new URL(`/${AS_WELL_KNOWN}`, candidate.origin);
			return toAuthorizationServerMetadata(await fetchJson(wellKnown, fetch));
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof OAuthDiscoveryError
		? lastError
		: new OAuthDiscoveryError(`no authorization server metadata found for ${options.serverUrl}`);
}
