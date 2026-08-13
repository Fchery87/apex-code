import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import * as net from "node:net";
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

describe.skipIf(!canEnforceLinuxSandbox())("CLI sandbox network allowlist", () => {
	let testServer: http.Server;
	let testServerPort: number;

	beforeAll(async () => {
		testServer = http.createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("hello from test server");
		});
		await new Promise<void>((resolve) => {
			testServer.listen(0, "127.0.0.1", () => {
				testServerPort = (testServer.address() as net.AddressInfo).port;
				resolve();
			});
		});
	});

	afterAll(async () => {
		if (testServer) {
			await new Promise<void>((resolve) => testServer.close(() => resolve()));
		}
	});

	it("proves an allowed host succeeds and a blocked one fails closed with a recorded violation", async () => {
		const cwd = workspace();
		let stderr = "";
		const stderrMsgs: string[] = [];

		// Test blocked host (127.0.0.1 not in allowedHosts)
		const codeBlocked = await launchSandboxedCli({
			command: "/home/nochaserz/.bun/bin/bun",
			args: ["-e", `
				await new Promise((resolve) => {
					const net = require('net');
					const url = new URL(process.env.HTTP_PROXY);
					const c = net.connect(url.port, url.hostname, () => {
						c.write("CONNECT 127.0.0.1:" + ${testServerPort} + " HTTP/1.1\\r\\nHost: 127.0.0.1:" + ${testServerPort} + "\\r\\n\\r\\n");
					});
					c.on('data', d => {
						if (d.toString().includes('200')) process.exit(0);
						else process.exit(1);
					});
					c.on('error', () => process.exit(1));
					c.on('close', () => process.exit(1));
				});
			`],
			environment: {},
			workspace: cwd,
			allowedHosts: ["example.com"],
			dependencies: {
				stderr: {
					write: (message) => {
						stderrMsgs.push(message);
						stderr = stderrMsgs.join("");
						return true;
					},
				},
			},
		});

		expect(codeBlocked).not.toBe(0);
		expect(stderr).toContain("Sandbox violation (network)");
		expect(stderr).toContain("connection to 127.0.0.1 refused by allowlist policy");

		// Test allowed host (127.0.0.1 in allowedHosts)
		let stderrAllowed = "";
		const codeAllowed = await launchSandboxedCli({
			command: "/home/nochaserz/.bun/bin/bun",
			args: ["-e", `
				await new Promise((resolve) => {
					const net = require('net');
					const url = new URL(process.env.HTTP_PROXY);
					const c = net.connect(url.port, url.hostname, () => {
						c.write("CONNECT 127.0.0.1:" + ${testServerPort} + " HTTP/1.1\\r\\nHost: 127.0.0.1:" + ${testServerPort} + "\\r\\n\\r\\n");
					});
					c.on('data', d => {
						if (d.toString().includes('200')) process.exit(0);
						else process.exit(1);
					});
					c.on('error', () => process.exit(1));
					c.on('close', () => process.exit(1));
				});
			`],
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
