import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createWebFetchTool } from "../../src/core/tools/web-fetch.ts";

interface LocalServer {
	url: string;
	hostHeaders: string[];
	close(): Promise<void>;
}

async function startServer(
	handler: (path: string) => { status: number; location?: string; body?: string },
): Promise<LocalServer> {
	const hostHeaders: string[] = [];
	const server: Server = createServer((request, response) => {
		hostHeaders.push(request.headers.host ?? "");
		const result = handler(request.url ?? "/");
		response.writeHead(result.status, result.location ? { location: result.location } : {});
		response.end(result.body ?? "");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		hostHeaders,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const servers: LocalServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(handler: Parameters<typeof startServer>[0]): Promise<LocalServer> {
	const server = await startServer(handler);
	servers.push(server);
	return server;
}

function fetchTool(allowPrivateNetwork: boolean) {
	return createWebFetchTool({ allowPrivateNetwork });
}

async function run(tool: ReturnType<typeof fetchTool>, url: string): Promise<string> {
	const result = await tool.execute("call", { url });
	return (result.content[0] as { text: string }).text;
}

describe("web_fetch redirects (HR.3)", () => {
	it("follows a redirect that stays on the same host", async () => {
		const server = await serve((path) => {
			if (path === "/a") return { status: 302, location: "/b" };
			return { status: 200, body: "landed" };
		});
		const text = await run(fetchTool(true), `${server.url}/a`);
		expect(text).toBe("landed");
	});

	it("does not contact a different host; it returns the target URL for a separate, gated fetch", async () => {
		const target = await serve(() => ({ status: 200, body: "should not be fetched" }));
		const origin = await serve(() => ({
			status: 302,
			location: `http://localhost:${new URL(target.url).port}/x`,
		}));
		const text = await run(fetchTool(true), `${origin.url}/start`);
		expect(text).toContain("different host");
		expect(text).toContain("http://localhost:");
		expect(target.hostHeaders).toHaveLength(0);
	});

	it("stops after five same-host redirects", async () => {
		const server = await serve((path) => {
			const next = Number(path.slice(1)) + 1;
			return { status: 302, location: `/${next}` };
		});
		await expect(run(fetchTool(true), `${server.url}/0`)).rejects.toThrow(/too many redirects/);
	});
});

describe("web_fetch private-network guard (HR.4)", () => {
	const refused = [
		"http://169.254.169.254/latest/meta-data/",
		"http://10.0.0.1/",
		"http://172.16.4.2/",
		"http://192.168.1.1/",
		"http://100.64.0.1/",
		"http://127.0.0.1:1/",
		"http://[::1]/",
		"http://[fc00::1]/",
		"http://[fe80::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:7f00:1]/",
		"http://0.0.0.0/",
	];

	for (const url of refused) {
		it(`refuses ${url} with the setting named in the error`, async () => {
			await expect(run(fetchTool(false), url)).rejects.toThrow(/webFetch\.allowPrivateNetwork/);
		});
	}

	it("refuses a non-http scheme", async () => {
		await expect(run(fetchTool(false), "file:///etc/passwd")).rejects.toThrow(/unsupported URL scheme/);
	});

	it("refuses a hostname that resolves to loopback", async () => {
		await expect(run(fetchTool(false), "http://localhost:1/")).rejects.toThrow(/webFetch\.allowPrivateNetwork/);
	});

	it("allows loopback when the setting is enabled", async () => {
		const server = await serve(() => ({ status: 200, body: "local ok" }));
		expect(await run(fetchTool(true), `${server.url}/`)).toBe("local ok");
	});
});
