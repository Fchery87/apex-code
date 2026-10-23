import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectDevTools } from "../../src/core/tools/browser-connection.ts";

/** Speaks the DevTools HTTP and WebSocket shape well enough to answer one command. */
function devtoolsServer(): Promise<{ server: Server; port: number; seen: string[] }> {
	const seen: string[] = [];
	const server = createServer((_request, response) => {
		const port = (server.address() as AddressInfo).port;
		response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser` }));
	});
	server.on("upgrade", (request, socket) => {
		const key = request.headers["sec-websocket-key"];
		const accept = require("node:crypto")
			.createHash("sha1")
			.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		socket.on("data", (data: Buffer) => {
			const text = decodeFrame(data);
			if (!text) return;
			seen.push(text);
			const command = JSON.parse(text) as { id: number };
			socket.write(encodeFrame(JSON.stringify({ id: command.id, result: { ok: true } })));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, seen }));
	});
}

function decodeFrame(frame: Buffer): string | undefined {
	if (frame[0] !== 0x81) return undefined;
	const length = frame[1] & 0x7f;
	const mask = frame.subarray(2, 6);
	const payload = frame.subarray(6, 6 + length);
	return Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4])).toString();
}

function encodeFrame(text: string): Buffer {
	const payload = Buffer.from(text);
	return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

describe("DevTools connection", () => {
	const servers: Server[] = [];
	afterEach(() => {
		for (const server of servers.splice(0)) server.close();
	});

	it("reads the browser socket from /json/version and sends a command", async () => {
		const running = await devtoolsServer();
		servers.push(running.server);
		const connection = await connectDevTools(running.port);
		const reply = await connection.request("Browser.getVersion");
		expect(reply.result).toEqual({ ok: true });
		expect(running.seen[0]).toContain("Browser.getVersion");
	});
});
