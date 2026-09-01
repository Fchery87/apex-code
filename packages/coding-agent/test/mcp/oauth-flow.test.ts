import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { OAuthFlowError, runMcpOAuthFlow } from "../../src/core/mcp/oauth/flow.ts";

interface TestAuthority {
	url: URL;
	/** Challenge the authorization endpoint saw, exposed for the token handler's PKCE check. */
	challenge: { value: string };
	registered: () => number;
	tokenBodies: URLSearchParams[];
	close: () => Promise<void>;
}

async function startAuthority(options: { registrationEndpoint: boolean }): Promise<TestAuthority> {
	const challenge = { value: "" };
	let registrations = 0;
	const tokenBodies: URLSearchParams[] = [];
	const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
		// Endpoints advertised in metadata must carry the real port, so build them from
		// the request's Host header rather than a hardcoded origin.
		const base = `http://${String(request.headers.host ?? "127.0.0.1")}`;
		const url = new URL(String(request.url), base);
		const respond = (status: number, body: unknown, headers?: Record<string, string>) => {
			response.writeHead(status, headers);
			response.end(typeof body === "string" ? body : JSON.stringify(body));
		};
		if (request.method === "GET" && url.pathname === "/mcp") return respond(404, "no");
		if (request.method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource"))
			return respond(404, "no");
		if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
			return respond(200, {
				authorization_endpoint: new URL("/authorize", url.origin).toString(),
				token_endpoint: new URL("/token", url.origin).toString(),
				...(options.registrationEndpoint
					? { registration_endpoint: new URL("/register", url.origin).toString() }
					: {}),
			});
		}
		if (request.method === "POST" && url.pathname === "/register") {
			registrations += 1;
			return respond(200, { client_id: "dynamic-client" });
		}
		if (request.method === "GET" && url.pathname === "/authorize") {
			const redirectUri = String(url.searchParams.get("redirect_uri"));
			const state = String(url.searchParams.get("state"));
			challenge.value = String(url.searchParams.get("code_challenge"));
			const code = "issued-code";
			const location = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
			return respond(302, "", { location });
		}
		if (request.method === "POST" && url.pathname === "/token") {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				tokenBodies.push(new URLSearchParams(Buffer.concat(chunks).toString()));
				respond(200, { access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 });
			});
			return;
		}
		respond(404, "no");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	return {
		url: new URL(`http://127.0.0.1:${address.port}`),
		challenge,
		registered: () => registrations,
		tokenBodies,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	};
}

async function assertClosed(port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			reject(new Error("listener still accepting"));
		});
		socket.once("error", () => {
			resolve();
		});
	});
}

function printedAuthorizeUrl(printed: string[]): URL {
	// The printed line is human-readable; the URL is its last whitespace-delimited token.
	return new URL(printed[0]!.trim().split(/\s+/).pop()!);
}

describe("runMcpOAuthFlow", () => {
	it(
		"discovers, registers, authorizes over loopback, exchanges with PKCE, and persists to the store",
		{ timeout: 15_000 },
		async () => {
			const authority = await startAuthority({ registrationEndpoint: true });
			try {
				const credentials = AuthStorage.inMemory();
				const printed: string[] = [];
				const openBrowser = vi.fn();

				const resultPromise = runMcpOAuthFlow({
					serverName: "local",
					serverUrl: new URL("/mcp", authority.url).toString(),
					credentials,
					deps: { print: (line) => printed.push(line), openBrowser },
				});

				// Simulate the browser: take the printed authorize URL, follow the redirect manually,
				// then deliver the code to the loopback listener ourselves.
				let callbackUrl: URL | undefined;
				const result = await (async () => {
					const promise = resultPromise;
					for (let i = 0; i < 100 && printed.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
					expect(printed).toHaveLength(1);
					const authorizeUrl = printedAuthorizeUrl(printed);
					expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
					expect(authorizeUrl.searchParams.get("client_id")).toBe("dynamic-client");
					expect(authorizeUrl.searchParams.get("resource")).toBe(new URL("/mcp", authority.url).toString());
					const redirect = await fetch(authorizeUrl, { redirect: "manual" });
					const location = redirect.headers.get("location");
					expect(location).toBeTruthy();
					callbackUrl = new URL(String(location));
					const delivered = await fetch(callbackUrl);
					expect(delivered.status).toBe(200);
					return promise;
				})();

				expect(openBrowser).toHaveBeenCalledTimes(1);
				expect(result.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);

				const stored = await credentials.read("mcp/local");
				expect(stored?.type).toBe("oauth");
				if (stored?.type !== "oauth") throw new Error("unreachable");
				expect(stored.access).toBe("fresh-access");
				expect(stored.refresh).toBe("fresh-refresh");
				expect(stored.tokenEndpoint).toBe(new URL("/token", authority.url).toString());
				expect(stored.resource).toBe(new URL("/mcp", authority.url).toString());

				// PKCE held end to end: the token endpoint received the verifier matching the challenge.
				expect(authority.tokenBodies).toHaveLength(1);
				const tokenBody = authority.tokenBodies[0]!;
				expect(tokenBody.get("grant_type")).toBe("authorization_code");
				const { createHash } = await import("node:crypto");
				expect(
					createHash("sha256")
						.update(String(tokenBody.get("code_verifier")), "ascii")
						.digest("base64url"),
				).toBe(authority.challenge.value);

				await assertClosed(Number(callbackUrl!.port));
			} finally {
				await authority.close();
			}
		},
	);

	it("keeps listening after a wrong-state callback and completes on the right one", { timeout: 15_000 }, async () => {
		const authority = await startAuthority({ registrationEndpoint: true });
		try {
			const credentials = AuthStorage.inMemory();
			const printed: string[] = [];
			const result = runMcpOAuthFlow({
				serverName: "local",
				serverUrl: new URL("/mcp", authority.url).toString(),
				credentials,
				deps: { print: (line) => printed.push(line), openBrowser: () => {} },
			});
			for (let i = 0; i < 100 && printed.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
			const authorizeUrl = printedAuthorizeUrl(printed);
			const redirect = await fetch(authorizeUrl, { redirect: "manual" });
			const callbackUrl = new URL(String(redirect.headers.get("location")));

			const wrong = new URL(callbackUrl);
			wrong.searchParams.set("state", "not-the-state");
			expect((await fetch(wrong)).status).toBe(400);

			expect((await fetch(callbackUrl)).status).toBe(200);
			await result;
			const stored = await credentials.read("mcp/local");
			expect(stored?.type).toBe("oauth");
		} finally {
			await authority.close();
		}
	});

	it(
		"fails with a named error and closes the listener when nobody completes the flow",
		{ timeout: 15_000 },
		async () => {
			const authority = await startAuthority({ registrationEndpoint: true });
			try {
				const credentials = AuthStorage.inMemory();
				const printed: string[] = [];
				await expect(
					runMcpOAuthFlow({
						serverName: "local",
						serverUrl: new URL("/mcp", authority.url).toString(),
						credentials,
						deps: { print: (line) => printed.push(line), openBrowser: () => {}, timeoutMs: 150 },
					}),
				).rejects.toBeInstanceOf(OAuthFlowError);

				const authorizeUrl = printedAuthorizeUrl(printed);
				const port = Number(new URL(authorizeUrl.searchParams.get("redirect_uri")!).port);
				await assertClosed(port);
			} finally {
				await authority.close();
			}
		},
	);

	it("uses a caller-provided client id without dynamic registration", { timeout: 15_000 }, async () => {
		const authority = await startAuthority({ registrationEndpoint: false });
		try {
			const credentials = AuthStorage.inMemory();
			const printed: string[] = [];
			const result = runMcpOAuthFlow({
				serverName: "local",
				serverUrl: new URL("/mcp", authority.url).toString(),
				credentials,
				clientId: "manual-client",
				deps: { print: (line) => printed.push(line), openBrowser: () => {} },
			});
			for (let i = 0; i < 100 && printed.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
			expect(authority.registered()).toBe(0);
			const authorizeUrl = printedAuthorizeUrl(printed);
			expect(authorizeUrl.searchParams.get("client_id")).toBe("manual-client");
			const redirect = await fetch(authorizeUrl, { redirect: "manual" });
			await fetch(String(redirect.headers.get("location")));
			await result;
		} finally {
			await authority.close();
		}
	});

	it(
		"fails with manual-registration guidance when there is no registration endpoint and no client id",
		{ timeout: 15_000 },
		async () => {
			const authority = await startAuthority({ registrationEndpoint: false });
			try {
				const credentials = AuthStorage.inMemory();
				await expect(
					runMcpOAuthFlow({
						serverName: "local",
						serverUrl: new URL("/mcp", authority.url).toString(),
						credentials,
						deps: { print: () => {}, openBrowser: () => {} },
					}),
				).rejects.toThrow(/manual client registration/i);
			} finally {
				await authority.close();
			}
		},
	);
});
