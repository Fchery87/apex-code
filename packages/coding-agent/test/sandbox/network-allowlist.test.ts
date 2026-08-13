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
	const directory = mkdtempSync(join(tmpdir(), "apex-sandbox-network-"));
	directories.push(directory);
	return directory;
}

/**
 * A CONNECT request through the proxy at $HTTP_PROXY, exiting 0 on "200" and 1
 * otherwise. Uses process.execPath (not a third-party runtime) so it runs on any
 * host that can run this test suite at all, matching every other sandbox test.
 */
function connectProbeScript(port: number): string {
	return `
		const net = require("node:net");
		const url = new URL(process.env.HTTP_PROXY);
		const c = net.connect(Number(url.port), url.hostname, () => {
			c.write("CONNECT 127.0.0.1:${port} HTTP/1.1\\r\\nHost: 127.0.0.1:${port}\\r\\n\\r\\n");
		});
		c.on("data", (d) => process.exit(d.toString().includes("200") ? 0 : 1));
		c.on("error", () => process.exit(1));
		c.on("close", () => process.exit(1));
	`;
}

describe.skipIf(!canEnforceLinuxSandbox())("CLI sandbox network allowlist", () => {
	let testServer: http.Server;
	let testServerPort: number;

	beforeAll(async () => {
		testServer = http.createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("hello from test server");
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

	it("proves an allowed host succeeds and a blocked one fails closed with a recorded violation", async () => {
		const cwd = workspace();
		let stderr = "";

		const codeBlocked = await launchSandboxedCli({
			command: process.execPath,
			args: ["-e", connectProbeScript(testServerPort)],
			environment: {},
			workspace: cwd,
			allowedHosts: ["example.com"],
			dependencies: {
				stderr: {
					write: (message) => {
						stderr += message;
						return true;
					},
				},
			},
		});

		expect(codeBlocked).not.toBe(0);
		expect(stderr).toContain("Sandbox violation (network)");
		expect(stderr).toContain(`CONNECT 127.0.0.1:${testServerPort}`);
		expect(stderr).toContain("refused by allowlist policy");
		expect(stderr).not.toContain("Network is unreachable");
		// The whole sandboxed process also exits non-zero (the probe script exits 1
		// once refused), so the outer process-exit classifier records its own generic
		// "unknown" fallback alongside the proxy's precise "network" record. Both are
		// expected here; only the proxy's record needs to describe the real cause.
		expect(stderr).toContain("Sandbox violation (unknown)");

		let stderrAllowed = "";
		const codeAllowed = await launchSandboxedCli({
			command: process.execPath,
			args: ["-e", connectProbeScript(testServerPort)],
			environment: {},
			workspace: cwd,
			allowedHosts: ["127.0.0.1"],
			dependencies: {
				stderr: {
					write: (message) => {
						stderrAllowed += message;
						return true;
					},
				},
			},
		});

		expect(codeAllowed).toBe(0);
		expect(stderrAllowed).not.toContain("Sandbox violation");
	});
});
