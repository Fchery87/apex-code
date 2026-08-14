/**
 * Task 4.4 (web_search/web_fetch): these tools never implement or bypass the
 * sandbox boundary themselves -- they call `globalThis.fetch`, made proxy-aware by
 * `configureHttpDispatcher`'s `undici.EnvHttpProxyAgent` (see `core/http-dispatcher.ts`
 * and `web-fetch.test.ts`'s "delegates to globalThis.fetch" case). `EnvHttpProxyAgent`
 * always tunnels through `HTTP_PROXY`/`HTTPS_PROXY` via CONNECT, for both http and
 * https destinations -- which is exactly what `network-proxy.ts`'s server implements
 * (it 405s any non-CONNECT request). This file proves that CONNECT-tunnel mechanism
 * carries real request/response bytes end-to-end inside a genuine bwrap-sandboxed
 * child: an allowed host's tunnel relays a real HTTP exchange, a disallowed host's
 * does not, and a raw connection that ignores the proxy entirely (what a tool would
 * do if it opened its own socket instead of using fetch) still has no route at all --
 * `--unshare-net` does not care what a tool's own JS code intended to do.
 *
 * `network-allowlist.test.ts` already covers the CONNECT accept/reject decision at
 * the proxy-response-line level; this file is the same mechanism carried one layer
 * further, to actual HTTP data, and adds the bypass-attempt case.
 */
import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import type * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchSandboxedCli } from "../../src/core/sandbox/cli-supervisor.ts";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";

function canEnforceLinuxSandbox(): boolean {
	return process.platform === "linux" && createLinuxSandboxBackend().status.kind === "enforced";
}

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-sandbox-fetch-mechanism-"));
	directories.push(directory);
	return directory;
}

/**
 * Establishes a CONNECT tunnel through $HTTP_PROXY, then sends a real HTTP/1.1 GET
 * inside it and prints whatever comes back. Exits 0 only if the response contains
 * the marker text the test server sends -- proving actual bytes flowed, not just a
 * "200 Connection Established" proxy handshake.
 */
function fetchThroughProxyScript(port: number): string {
	return `
		const net = require("node:net");
		const url = new URL(process.env.HTTP_PROXY);
		const c = net.connect(Number(url.port), url.hostname, () => {
			c.write("CONNECT 127.0.0.1:${port} HTTP/1.1\\r\\nHost: 127.0.0.1:${port}\\r\\n\\r\\n");
		});
		let established = false;
		let buffer = "";
		c.on("data", (d) => {
			buffer += d.toString();
			if (!established) {
				if (!buffer.includes("200")) { process.exit(1); }
				established = true;
				c.write("GET / HTTP/1.1\\r\\nHost: 127.0.0.1:${port}\\r\\nConnection: close\\r\\n\\r\\n");
				buffer = "";
				return;
			}
			if (buffer.includes("MECHANISM_MARKER")) { process.exit(0); }
		});
		c.on("close", () => process.exit(1));
		c.on("error", () => process.exit(1));
	`;
}

/** Opens a raw socket straight to the test server, ignoring $HTTP_PROXY entirely -- the bypass-attempt case. */
function bypassProxyScript(port: number): string {
	return `
		const net = require("node:net");
		const c = net.connect(${port}, "127.0.0.1", () => {
			c.write("GET / HTTP/1.1\\r\\nHost: 127.0.0.1:${port}\\r\\nConnection: close\\r\\n\\r\\n");
		});
		c.on("data", (d) => process.exit(d.toString().includes("MECHANISM_MARKER") ? 0 : 1));
		c.on("error", () => process.exit(1));
		c.on("close", () => process.exit(1));
	`;
}

describe.skipIf(!canEnforceLinuxSandbox())(
	"task 4.4: the fetch-proxy mechanism web_fetch/web_search rely on, exercised inside a real sandboxed child",
	() => {
		let testServer: http.Server;
		let testServerPort: number;

		beforeAll(async () => {
			testServer = http.createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("MECHANISM_MARKER");
			});
			await new Promise<void>((resolvePromise) => {
				testServer.listen(0, "127.0.0.1", () => {
					testServerPort = (testServer.address() as net.AddressInfo).port;
					resolvePromise();
				});
			});
		});

		afterAll(async () => {
			if (testServer) {
				await new Promise<void>((resolvePromise) => testServer.close(() => resolvePromise()));
			}
		});

		it("relays a real HTTP response through the proxy for an allowed host", async () => {
			const code = await launchSandboxedCli({
				command: process.execPath,
				args: ["-e", fetchThroughProxyScript(testServerPort)],
				environment: {},
				workspace: workspace(),
				allowedHosts: ["127.0.0.1"],
			});
			expect(code).toBe(0);
		});

		it("never relays a response for a host absent from the allowlist", async () => {
			const code = await launchSandboxedCli({
				command: process.execPath,
				args: ["-e", fetchThroughProxyScript(testServerPort)],
				environment: {},
				workspace: workspace(),
				allowedHosts: ["example.com"],
			});
			expect(code).not.toBe(0);
		});

		it("a raw socket that ignores $HTTP_PROXY entirely -- what a tool using a bare socket instead of fetch would do -- still has no route, even to an allowed host", async () => {
			const code = await launchSandboxedCli({
				command: process.execPath,
				args: ["-e", bypassProxyScript(testServerPort)],
				environment: {},
				workspace: workspace(),
				// Allowed at the proxy layer; irrelevant here since --unshare-net removes
				// the direct route this script tries to use, before the proxy is ever reached.
				allowedHosts: ["127.0.0.1"],
			});
			expect(code).not.toBe(0);
		});
	},
);
