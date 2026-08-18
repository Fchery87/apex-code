import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeSandboxNetworkRefusal,
	installSandboxNetworkRefusalMessages,
} from "../../src/core/sandbox/network-refusal.ts";

// undici reports a refused CONNECT two levels down the cause chain, and fetch surfaces
// only "fetch failed" at the top. Reproducing that shape by hand keeps these unit tests
// honest about what the runtime actually throws.
function tunnelRefusalError(status = 403): Error {
	const inner = Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), {
		name: "AbortError",
		code: "UND_ERR_ABORTED",
	});
	const middle = Object.assign(new Error("Request was cancelled."), { cause: inner });
	return Object.assign(new TypeError("fetch failed"), { cause: middle });
}

describe("sandbox network refusal messages", () => {
	it("names the refused host and the setting that would permit it", () => {
		const message = describeSandboxNetworkRefusal(
			tunnelRefusalError(),
			"https://generativelanguage.googleapis.com/v1beta/models",
		);

		expect(message).toContain("generativelanguage.googleapis.com");
		expect(message).toContain("network.allowedHosts");
	});

	it("ignores a failure that is not a proxy refusal", () => {
		const dnsFailure = Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.invalid"), { code: "ENOTFOUND" }),
		});

		expect(describeSandboxNetworkRefusal(dnsFailure, "https://example.invalid/")).toBeUndefined();
	});

	it("ignores a proxy that answered normally", () => {
		expect(describeSandboxNetworkRefusal(new TypeError("fetch failed"), "https://example.com/")).toBeUndefined();
	});
});

describe("sandbox network refusal, end to end", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("replaces 'fetch failed' with an actionable message through a real refusing proxy", async () => {
		// Mirrors network-proxy.ts's deny branch: refuse the tunnel with 403.
		const server = http.createServer((_request, response) => {
			response.writeHead(405);
			response.end();
		});
		server.on("connect", (_request, socket) => {
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;

		const previousProxy = process.env.HTTPS_PROXY;
		process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
		const { configureHttpDispatcher } = await import("../../src/core/http-dispatcher.ts");
		configureHttpDispatcher();
		installSandboxNetworkRefusalMessages();

		try {
			await expect(
				fetch("https://generativelanguage.googleapis.com/v1beta/models", { signal: AbortSignal.timeout(15_000) }),
			).rejects.toThrow(/generativelanguage\.googleapis\.com/);
		} finally {
			if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
			else process.env.HTTPS_PROXY = previousProxy;
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
