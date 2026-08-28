import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxNetworkProxy, type SandboxNetworkProxy } from "../../src/core/sandbox/network-proxy.ts";
import { SandboxViolationStore } from "../../src/core/sandbox/violations.ts";

const directories: string[] = [];
const proxies: SandboxNetworkProxy[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
	for (const proxy of proxies.splice(0)) await proxy.close();
	for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function socketPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-network-proxy-"));
	directories.push(directory);
	return join(directory, "proxy.sock");
}

async function targetServer(): Promise<number> {
	const server = http.createServer((_req, res) => res.end("ok"));
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return (server.address() as net.AddressInfo).port;
}

/** Issues a raw CONNECT through the proxy's UDS and resolves with the status line. */
function connectThroughProxy(proxySocketPath: string, hostname: string, port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(proxySocketPath, () => {
			socket.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`);
		});
		socket.on("data", (data) => {
			resolve(data.toString());
			socket.destroy();
		});
		socket.on("error", reject);
	});
}

/** Same as connectThroughProxy, but dials a TCP loopback port instead of a UDS. */
function connectThroughTcpProxy(proxyPort: number, hostname: string, port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(proxyPort, "127.0.0.1", () => {
			socket.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`);
		});
		socket.on("data", (data) => {
			resolve(data.toString());
			socket.destroy();
		});
		socket.on("error", reject);
	});
}

describe.skipIf(process.platform === "win32")("createSandboxNetworkProxy allowlist matching", () => {
	it("allows a host:port entry only on that exact port, not on other ports of the same host", async () => {
		const port = await targetServer();
		const otherPort = await targetServer();
		const path = socketPath();
		const proxy = await createSandboxNetworkProxy({
			socketPath: path,
			allowedHosts: [`127.0.0.1:${port}`],
		});
		proxies.push(proxy);

		const allowedResponse = await connectThroughProxy(path, "127.0.0.1", port);
		expect(allowedResponse).toContain("200");

		const blockedResponse = await connectThroughProxy(path, "127.0.0.1", otherPort);
		expect(blockedResponse).toContain("403");
	});

	it("records a network violation naming the refused port when a host:port entry blocks a different port", async () => {
		const port = await targetServer();
		const otherPort = await targetServer();
		const violationStore = new SandboxViolationStore();
		const path = socketPath();
		const proxy = await createSandboxNetworkProxy({
			socketPath: path,
			allowedHosts: [`127.0.0.1:${port}`],
			violationStore,
		});
		proxies.push(proxy);

		await connectThroughProxy(path, "127.0.0.1", otherPort);

		expect(violationStore.list()).toHaveLength(1);
		expect(violationStore.list()[0]?.command).toBe(`CONNECT 127.0.0.1:${otherPort}`);
	});

	it("still allows a bare hostname entry on any port, preserving existing behavior", async () => {
		const port = await targetServer();
		const path = socketPath();
		const proxy = await createSandboxNetworkProxy({
			socketPath: path,
			allowedHosts: ["127.0.0.1"],
		});
		proxies.push(proxy);

		const response = await connectThroughProxy(path, "127.0.0.1", port);
		expect(response).toContain("200");
	});
});

describe("createSandboxNetworkProxy TCP-listen mode", () => {
	it("listens on a loopback TCP port instead of a UDS when tcpHost is given, and exposes the bound port", async () => {
		const port = await targetServer();
		const proxy = await createSandboxNetworkProxy({
			tcpHost: "127.0.0.1",
			allowedHosts: [`127.0.0.1:${port}`],
		});
		proxies.push(proxy);

		expect(typeof proxy.port).toBe("number");
		const response = await connectThroughTcpProxy(proxy.port as number, "127.0.0.1", port);
		expect(response).toContain("200");
	});

	it("still enforces the allowlist over TCP the same way it does over a UDS", async () => {
		const port = await targetServer();
		const otherPort = await targetServer();
		const proxy = await createSandboxNetworkProxy({
			tcpHost: "127.0.0.1",
			allowedHosts: [`127.0.0.1:${port}`],
		});
		proxies.push(proxy);

		const blocked = await connectThroughTcpProxy(proxy.port as number, "127.0.0.1", otherPort);
		expect(blocked).toContain("403");
	});
});

describe.skipIf(process.platform === "win32")("sandbox network proxy escalation", () => {
	it("asks the approver for a refused host, naming exactly that host and port", async () => {
		const port = await targetServer();
		const asked: string[] = [];
		const proxy = await createSandboxNetworkProxy({
			socketPath: socketPath(),
			allowedHosts: [],
			requestApproval: async (hostname, requestedPort) => {
				asked.push(`${hostname}:${requestedPort}`);
				return true;
			},
		});
		proxies.push(proxy);

		const status = await connectThroughProxy(proxy.server.address() as string, "127.0.0.1", port);

		expect(status).toContain("200");
		expect(asked).toEqual([`127.0.0.1:${port}`]);
	});

	it("grants only the approved host, leaving a different one refused", async () => {
		const port = await targetServer();
		const proxy = await createSandboxNetworkProxy({
			socketPath: socketPath(),
			allowedHosts: [],
			// Approve the loopback literal only. "localhost" resolves to the same machine
			// and the same port, so a grant that leaked by address rather than by the name
			// that was asked about would show up here as a 200.
			requestApproval: async (hostname) => hostname === "127.0.0.1",
		});
		proxies.push(proxy);

		await expect(connectThroughProxy(proxy.server.address() as string, "127.0.0.1", port)).resolves.toContain("200");
		await expect(connectThroughProxy(proxy.server.address() as string, "localhost", port)).resolves.toContain("403");
	});

	it("asks once for a host already granted, rather than on every connection", async () => {
		const port = await targetServer();
		let asks = 0;
		const proxy = await createSandboxNetworkProxy({
			socketPath: socketPath(),
			allowedHosts: [],
			requestApproval: async () => {
				asks += 1;
				return true;
			},
		});
		proxies.push(proxy);

		await connectThroughProxy(proxy.server.address() as string, "127.0.0.1", port);
		await connectThroughProxy(proxy.server.address() as string, "127.0.0.1", port);

		expect(asks).toBe(1);
	});

	it("raises one prompt for concurrent connections to the same refused host", async () => {
		const port = await targetServer();
		let asks = 0;
		const proxy = await createSandboxNetworkProxy({
			socketPath: socketPath(),
			allowedHosts: [],
			requestApproval: async () => {
				asks += 1;
				// A real prompt is slow. Without in-flight coalescing every connection that
				// arrives while the human is reading raises its own prompt.
				await new Promise((r) => setTimeout(r, 50));
				return true;
			},
		});
		proxies.push(proxy);

		const address = proxy.server.address() as string;
		await Promise.all([
			connectThroughProxy(address, "127.0.0.1", port),
			connectThroughProxy(address, "127.0.0.1", port),
			connectThroughProxy(address, "127.0.0.1", port),
		]);

		expect(asks).toBe(1);
	});

	it("keeps a declined host refused instead of caching the refusal as a grant", async () => {
		const port = await targetServer();
		let asks = 0;
		const proxy = await createSandboxNetworkProxy({
			socketPath: socketPath(),
			allowedHosts: [],
			requestApproval: async () => {
				asks += 1;
				return false;
			},
		});
		proxies.push(proxy);

		const address = proxy.server.address() as string;
		await expect(connectThroughProxy(address, "127.0.0.1", port)).resolves.toContain("403");
		await expect(connectThroughProxy(address, "127.0.0.1", port)).resolves.toContain("403");
		expect(asks).toBe(2);
	});

	it("records a violation for a declined host, exactly as an unasked refusal does", async () => {
		const port = await targetServer();
		const violationStore = new SandboxViolationStore();
		const proxy = await createSandboxNetworkProxy({
			socketPath: socketPath(),
			allowedHosts: [],
			violationStore,
			requestApproval: async () => false,
		});
		proxies.push(proxy);

		await connectThroughProxy(proxy.server.address() as string, "127.0.0.1", port);

		expect(violationStore.list()).toHaveLength(1);
		expect(violationStore.list()[0]).toMatchObject({ kind: "network" });
	});

	it("records no violation for a host the human approved", async () => {
		const port = await targetServer();
		const violationStore = new SandboxViolationStore();
		const proxy = await createSandboxNetworkProxy({
			socketPath: socketPath(),
			allowedHosts: [],
			violationStore,
			requestApproval: async () => true,
		});
		proxies.push(proxy);

		await connectThroughProxy(proxy.server.address() as string, "127.0.0.1", port);

		expect(violationStore.list()).toHaveLength(0);
	});

	it("denies without asking when no approver is configured, preserving ADR 0005 headless behaviour", async () => {
		const port = await targetServer();
		const proxy = await createSandboxNetworkProxy({ socketPath: socketPath(), allowedHosts: [] });
		proxies.push(proxy);

		await expect(connectThroughProxy(proxy.server.address() as string, "127.0.0.1", port)).resolves.toContain("403");
	});

	it("never asks about a host the configured allowlist already permits", async () => {
		const port = await targetServer();
		let asks = 0;
		const proxy = await createSandboxNetworkProxy({
			socketPath: socketPath(),
			allowedHosts: ["127.0.0.1"],
			requestApproval: async () => {
				asks += 1;
				return true;
			},
		});
		proxies.push(proxy);

		await expect(connectThroughProxy(proxy.server.address() as string, "127.0.0.1", port)).resolves.toContain("200");
		expect(asks).toBe(0);
	});
});

describe.skipIf(process.platform === "win32")("sandbox network reachability", () => {
	it("reports a configured host reachable, by bare name and by pinned port", async () => {
		const proxy = await createSandboxNetworkProxy({
			socketPath: socketPath(),
			allowedHosts: ["github.com", "registry.internal:8443"],
		});
		proxies.push(proxy);

		expect(proxy.isHostReachable("github.com")).toBe(true);
		expect(proxy.isHostReachable("registry.internal")).toBe(true);
		expect(proxy.isHostReachable("gitlab.com")).toBe(false);
	});

	it("reports a host reachable once the human granted it, not before", async () => {
		const port = await targetServer();
		const proxy = await createSandboxNetworkProxy({
			socketPath: socketPath(),
			allowedHosts: [],
			requestApproval: async () => true,
		});
		proxies.push(proxy);

		expect(proxy.isHostReachable("127.0.0.1")).toBe(false);
		await connectThroughProxy(proxy.server.address() as string, "127.0.0.1", port);
		expect(proxy.isHostReachable("127.0.0.1")).toBe(true);
	});
});
