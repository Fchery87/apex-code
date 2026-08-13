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

describe("createSandboxNetworkProxy allowlist matching", () => {
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
