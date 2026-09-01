import { type FetchLike, oauthErrorMessage } from "./discover.ts";

export interface RegisteredClient {
	clientId: string;
	clientSecret: string | undefined;
}

/**
 * RFC 7591 dynamic client registration. Public client only: the redirect lands on a
 * loopback listener and there is no client secret unless the server issues one.
 */
export async function registerClient(options: {
	registrationEndpoint: URL;
	clientName: string;
	redirectUris: string[];
	fetch?: FetchLike;
}): Promise<RegisteredClient> {
	const fetch = options.fetch ?? globalThis.fetch;
	let response: Response;
	try {
		response = await fetch(options.registrationEndpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: options.clientName,
				redirect_uris: options.redirectUris,
				grant_types: ["authorization_code"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
		});
	} catch (error) {
		throw new Error(
			`dynamic client registration unreachable at ${options.registrationEndpoint}: ${oauthErrorMessage(error)}`,
		);
	}
	let parsed: Record<string, unknown> = {};
	try {
		const value: unknown = await response.json();
		if (typeof value === "object" && value !== null) parsed = value as Record<string, unknown>;
	} catch {
		// Falls through to the failure below.
	}
	if (!response.ok || typeof parsed.client_id !== "string") {
		throw new Error(
			`dynamic client registration failed at ${options.registrationEndpoint} (HTTP ${response.status})`,
		);
	}
	return {
		clientId: parsed.client_id,
		clientSecret: typeof parsed.client_secret === "string" ? parsed.client_secret : undefined,
	};
}
