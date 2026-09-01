import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AcpHost, type AcpPromptableSession, AcpServer } from "../../src/modes/acp/server.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/modes/rpc/jsonl.ts";

const directories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function newCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "apex-acp-"));
	directories.push(cwd);
	return cwd;
}

/** Minimal structural fake of the parts of AgentSession the server drives. */
function fakeSession(overrides: { prompt?: (text: string) => Promise<unknown> } = {}) {
	return {
		prompt:
			overrides.prompt ??
			vi.fn(async () => {
				throw new Error("unexpected prompt");
			}),
		abort: vi.fn(async () => {}),
		subscribe: () => () => {},
		messages: [],
	};
}

function fakeHost(
	session: unknown,
	options: { createSession?: (cwd: string) => Promise<AcpPromptableSession> } = {},
): AcpHost {
	const promptable = session as AcpPromptableSession;
	return {
		getSession: () => promptable,
		createSession: options.createSession ?? (async () => promptable),
		loadSession: async () => promptable,
		setMode: vi.fn(async () => {}),
	};
}

/** Drive the server over in-memory streams and collect its written frames. */
function startServer(host: AcpHost) {
	const input = new PassThrough();
	const output = new PassThrough();
	const written: Array<Record<string, unknown>> = [];
	attachJsonlLineReader(output, (line) => written.push(JSON.parse(line)));
	const server = new AcpServer({ input, output, host });
	server.start();
	return {
		server,
		written,
		send: (value: Record<string, unknown>) => input.write(serializeJsonLine(value)),
		raw: input,
	};
}

const responseFor = (written: Array<Record<string, unknown>>, id: number | string) =>
	written.find((message) => message.id === id && (message.result !== undefined || message.error !== undefined));

describe("acp server dispatch", () => {
	it("answers initialize with protocol version 1, loadSession, and no auth methods", () => {
		const { server, written } = startServer(fakeHost(fakeSession()));
		server.handleLine(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "test-client" } },
			}),
		);

		expect(responseFor(written, 0)).toMatchObject({
			jsonrpc: "2.0",
			id: 0,
			result: {
				protocolVersion: 1,
				agentCapabilities: { loadSession: true },
				authMethods: [],
				agentInfo: { name: "apex-code" },
			},
		});
	});

	it("creates a session for session/new with the requested cwd", async () => {
		const cwd = newCwd();
		const session = fakeSession();
		const createSession = vi.fn(async (requested: string) => {
			expect(requested).toBe(cwd);
			return session;
		});
		const { written, send } = startServer(fakeHost(session, { createSession }));

		send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd, mcpServers: [] } });
		await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());

		expect(responseFor(written, 1)?.result).toHaveProperty("sessionId");
		expect(createSession).toHaveBeenCalledWith(cwd);
	});

	it("drives a prompt turn and answers with end_turn", async () => {
		const session = fakeSession({ prompt: vi.fn(async () => ({ stopReason: "end_turn" })) });
		const { server, written, send } = startServer(fakeHost(session));
		server.handleLine(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "session/new",
				params: { cwd: newCwd(), mcpServers: [] },
			}),
		);
		await vi.waitFor(() => expect(responseFor(written, 1)).toBeDefined());
		const sessionId = (responseFor(written, 1)!.result as { sessionId: string }).sessionId;

		send({
			jsonrpc: "2.0",
			id: 2,
			method: "session/prompt",
			params: {
				sessionId,
				prompt: [
					{ type: "text", text: "hello" },
					{ type: "text", text: "world" },
				],
			},
		});
		await vi.waitFor(() => expect(responseFor(written, 2)).toBeDefined());

		expect(session.prompt).toHaveBeenCalledWith("hello\nworld", expect.objectContaining({ source: "acp" }));
		expect(responseFor(written, 2)?.result).toEqual({ stopReason: "end_turn" });
	});

	it("maps session/cancel to the session abort path", async () => {
		const session = fakeSession();
		const { server } = startServer(fakeHost(session));
		server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } }));
		await vi.waitFor(() => expect(session.abort).toHaveBeenCalled());
	});

	it("rejects unknown methods with a JSON-RPC error", () => {
		const { written, send } = startServer(fakeHost(fakeSession()));
		send({ jsonrpc: "2.0", id: 9, method: "totally/unknown", params: {} });
		expect(responseFor(written, 9)?.error).toMatchObject({ code: -32601 });
	});

	it("ignores malformed lines without corrupting the stream", () => {
		const { server, written, send } = startServer(fakeHost(fakeSession()));
		server.handleLine("this is not json");
		send({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: 1 } });
		expect(responseFor(written, 3)).toBeDefined();
	});
});

describe("acp permission bridge", () => {
	it("round-trips request_permission to a PermissionAnswer", async () => {
		const { server, written, raw } = startServer(fakeHost(fakeSession()));
		const pending = server.askPermission("sess_1", "bash", 'Run bash commands matching "git push"');

		await vi.waitFor(() => {
			expect(written.some((message) => message.method === "session/request_permission")).toBe(true);
		});
		const request = written.find((message) => message.method === "session/request_permission")!;
		expect(request.params).toMatchObject({
			sessionId: "sess_1",
			options: expect.arrayContaining([
				expect.objectContaining({ kind: "allow_once" }),
				expect.objectContaining({ kind: "allow_always" }),
				expect.objectContaining({ kind: "reject_once" }),
				expect.objectContaining({ kind: "reject_always" }),
			]),
		});

		raw.write(
			serializeJsonLine({
				jsonrpc: "2.0",
				id: request.id,
				result: { outcome: { outcome: "selected", optionId: "allow-always" } },
			}),
		);
		await expect(pending).resolves.toEqual({ allow: true, persist: true });
	});

	it("answers cancelled outcomes fail-closed", async () => {
		const { server, written, raw } = startServer(fakeHost(fakeSession()));
		const pending = server.askPermission("sess_1", "bash", "desc");

		await vi.waitFor(() => {
			expect(written.some((message) => message.method === "session/request_permission")).toBe(true);
		});
		const request = written.find((message) => message.method === "session/request_permission")!;
		raw.write(serializeJsonLine({ jsonrpc: "2.0", id: request.id, result: { outcome: { outcome: "cancelled" } } }));
		await expect(pending).resolves.toEqual({ allow: false });
	});
});
