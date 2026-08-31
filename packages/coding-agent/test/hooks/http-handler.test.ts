import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpHookHandler } from "../../src/core/hooks/http-handler.ts";
import type { HookEventPayload } from "../../src/core/hooks/types.ts";

const payload: HookEventPayload = {
	type: "tool_call",
	toolName: "bash",
	toolCallId: "t1",
	input: { command: "rm -rf /" },
};

let server: Server | undefined;
let serverUrl = "";
let lastBody = "";

beforeAll(async () => {
	server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => {
			raw += chunk;
		});
		request.on("end", () => {
			lastBody = raw;
			if (request.url === "/block") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ decision: "block", reason: "denied by policy endpoint" }));
			} else if (request.url === "/broken") {
				response.writeHead(500);
				response.end("boom");
			} else if (request.url === "/garbage") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end("not json");
			} else if (request.url === "/slow") {
				// Never responds; the handler's timeout must fire first.
			} else {
				response.writeHead(200, { "content-type": "application/json" });
				response.end("{}");
			}
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server!.address();
	serverUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server?.close(() => resolve()));
});

function handlerFor(path: string, timeoutMs?: number) {
	return httpHookHandler({
		type: "http",
		url: `${serverUrl}${path}`,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	});
}

describe("http hook handler", () => {
	it("POSTs the event payload as JSON and reads the decision from the 200 body", async () => {
		const outcome = await handlerFor("/block").execute(payload);

		expect(outcome).toEqual({ ok: true, decision: { decision: "block", reason: "denied by policy endpoint" } });
		expect(JSON.parse(lastBody)).toEqual(payload);
	});

	it("treats an empty JSON object as no decision", async () => {
		expect(await handlerFor("/none").execute(payload)).toEqual({ ok: true });
	});

	it("fails closed on a non-200 response", async () => {
		expect(await handlerFor("/broken").execute(payload)).toEqual({
			ok: false,
			warning: expect.stringContaining("500"),
		});
	});

	it("treats non-JSON 200 output as no decision plus a warning, never as allow", async () => {
		const outcome = await handlerFor("/garbage").execute(payload);
		expect(outcome).toEqual({ ok: true, warning: expect.stringContaining("not json") });
	});

	it("fails closed when the endpoint outlives its timeout", async () => {
		expect(await handlerFor("/slow", 100).execute(payload)).toEqual({
			ok: false,
			warning: expect.stringContaining("timed out"),
		});
	});
});
