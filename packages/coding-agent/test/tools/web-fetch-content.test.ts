import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createWebFetchTool } from "../../src/core/tools/web-fetch.ts";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function serve(respond: (path: string) => { type: string; body: string | Buffer }): Promise<string> {
	const server = createServer((request, response) => {
		const { type, body } = respond(request.url ?? "/");
		response.writeHead(200, { "content-type": type });
		response.end(body);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

async function fetchText(url: string): Promise<string> {
	const tool = createWebFetchTool({ allowPrivateNetwork: true });
	const result = await tool.execute("call", { url });
	return (result.content[0] as { text: string }).text;
}

describe("web_fetch returns readable text (HR.19)", () => {
	it("converts an HTML page to markdown, dropping the head, scripts, and styles", async () => {
		const head = `<title>Page</title><meta name="filler" content="${"x".repeat(60_000)}">`;
		const html = `<!doctype html><html><head>${head}<script>var secret = 1;</script></head><body><h1>Install</h1><p>Run the <strong>setup</strong> command.</p><style>.a{}</style></body></html>`;
		const url = await serve(() => ({ type: "text/html; charset=utf-8", body: html }));
		const text = await fetchText(url);
		expect(text).toContain("Install");
		expect(text).toContain("**setup**");
		expect(text).not.toContain("xxxxxxxxxx");
		expect(text).not.toContain("var secret");
		expect(text).not.toContain("<p>");
	});

	it("returns JSON as text, unchanged", async () => {
		const url = await serve(() => ({ type: "application/json", body: '{"name":"apex","ok":true}' }));
		expect(await fetchText(url)).toBe('{"name":"apex","ok":true}');
	});

	it("refuses an image and names its type, rather than returning bytes", async () => {
		const url = await serve(() => ({ type: "image/png", body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }));
		const text = await fetchText(url);
		expect(text).toMatch(/image\/png/);
		expect(text).toMatch(/not text/);
	});

	it("refuses a PDF", async () => {
		const url = await serve(() => ({ type: "application/pdf", body: "%PDF-1.4" }));
		expect(await fetchText(url)).toMatch(/application\/pdf/);
	});

	it("stops reading at the byte cap and says so", async () => {
		const chunk = "a".repeat(1024 * 1024);
		const url = await serve(() => ({ type: "text/plain", body: chunk.repeat(8) }));
		const text = await fetchText(url);
		expect(text.length).toBeLessThan(6 * 1024 * 1024);
		expect(text).toMatch(/truncated/);
	});
});
