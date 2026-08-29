import { describe, expect, it, vi } from "vitest";
import { McpServerManager } from "../../src/core/mcp/server-manager.ts";
import type { CachedTool, McpConnection, McpServerConfig } from "../../src/core/mcp/types.ts";

function server(name: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		name,
		transport: { kind: "stdio", command: name, args: [], env: {}, cwd: undefined },
		capabilities: new Set(["net"]),
		lifecycle: "lazy",
		idleTimeoutMinutes: 10,
		...overrides,
	};
}

function fakeConnection(tools: CachedTool[] = []): McpConnection & { closed: boolean } {
	const connection = {
		closed: false,
		listTools: async () => tools,
		callTool: async (name: string) => ({ content: [{ type: "text" as const, text: `called ${name}` }] }),
		close: async () => {
			connection.closed = true;
		},
	};
	return connection;
}

/** Controllable clock, so idle and backoff windows are asserted rather than waited out. */
function clock(start = 1_000_000) {
	let value = start;
	return {
		now: () => value,
		advanceMinutes: (minutes: number) => {
			value += minutes * 60_000;
		},
	};
}

describe("MCP server manager", () => {
	it("connects nothing at construction", () => {
		const connector = vi.fn();
		const manager = new McpServerManager({ servers: new Map([["a", server("a")]]), connector });

		expect(connector).not.toHaveBeenCalled();
		expect(manager.state("a")).toEqual({ kind: "disconnected" });
	});

	it("connects on the first call that needs the server", async () => {
		const connector = vi.fn(async () => fakeConnection());
		const manager = new McpServerManager({ servers: new Map([["a", server("a")]]), connector });

		await manager.withConnection("a", async (connection) => connection.listTools());

		expect(connector).toHaveBeenCalledTimes(1);
		expect(manager.state("a").kind).toBe("ready");
	});

	it("reuses a ready connection instead of reconnecting", async () => {
		const connector = vi.fn(async () => fakeConnection());
		const manager = new McpServerManager({ servers: new Map([["a", server("a")]]), connector });

		await manager.withConnection("a", async () => undefined);
		await manager.withConnection("a", async () => undefined);

		expect(connector).toHaveBeenCalledTimes(1);
	});

	it("disconnects a server left idle past its timeout", async () => {
		const time = clock();
		const connection = fakeConnection();
		const manager = new McpServerManager({
			servers: new Map([["a", server("a", { idleTimeoutMinutes: 10 })]]),
			connector: async () => connection,
			now: time.now,
		});

		await manager.withConnection("a", async () => undefined);
		time.advanceMinutes(11);
		await manager.sweepIdle();

		expect(manager.state("a")).toEqual({ kind: "disconnected" });
		expect(connection.closed).toBe(true);
	});

	it("keeps a server that is still inside its idle window", async () => {
		const time = clock();
		const manager = new McpServerManager({
			servers: new Map([["a", server("a", { idleTimeoutMinutes: 10 })]]),
			connector: async () => fakeConnection(),
			now: time.now,
		});

		await manager.withConnection("a", async () => undefined);
		time.advanceMinutes(9);
		await manager.sweepIdle();

		expect(manager.state("a").kind).toBe("ready");
	});

	it("never disconnects a keep-alive server on idle", async () => {
		const time = clock();
		const manager = new McpServerManager({
			servers: new Map([["a", server("a", { lifecycle: "keep-alive", idleTimeoutMinutes: 1 })]]),
			connector: async () => fakeConnection(),
			now: time.now,
		});

		await manager.withConnection("a", async () => undefined);
		time.advanceMinutes(600);
		await manager.sweepIdle();

		expect(manager.state("a").kind).toBe("ready");
	});

	it("records a failure with a retry window and does not respawn inside it", async () => {
		const time = clock();
		const connector = vi.fn(async () => {
			throw new Error("boom");
		});
		const manager = new McpServerManager({
			servers: new Map([["a", server("a")]]),
			connector,
			now: time.now,
		});

		await expect(manager.withConnection("a", async () => undefined)).rejects.toThrow(/boom/);
		const state = manager.state("a");
		expect(state.kind).toBe("failed");
		expect(state.kind === "failed" && state.retryAfter).toBeGreaterThan(time.now());

		await expect(manager.withConnection("a", async () => undefined)).rejects.toThrow(/boom/);
		expect(connector).toHaveBeenCalledTimes(1);
	});

	it("retries once the backoff window has passed", async () => {
		const time = clock();
		let attempts = 0;
		const manager = new McpServerManager({
			servers: new Map([["a", server("a")]]),
			connector: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("boom");
				return fakeConnection();
			},
			now: time.now,
		});

		await expect(manager.withConnection("a", async () => undefined)).rejects.toThrow();
		time.advanceMinutes(10);
		await manager.withConnection("a", async () => undefined);

		expect(attempts).toBe(2);
		expect(manager.state("a").kind).toBe("ready");
	});

	it("bounds a connect that never completes", async () => {
		const manager = new McpServerManager({
			servers: new Map([["a", server("a")]]),
			connector: () => new Promise<McpConnection>(() => {}),
			connectTimeoutMs: 20,
		});

		await expect(manager.withConnection("a", async () => undefined)).rejects.toThrow(/timed out/i);
		expect(manager.state("a").kind).toBe("failed");
	});

	it("warms only eager servers, leaving lazy ones untouched", async () => {
		const connected: string[] = [];
		const manager = new McpServerManager({
			servers: new Map([
				["eagerly", server("eagerly", { lifecycle: "eager" })],
				["lazily", server("lazily", { lifecycle: "lazy" })],
			]),
			connector: async (config) => {
				connected.push(config.name);
				return fakeConnection([{ server: config.name, name: "t", description: "d", inputSchema: {} }]);
			},
		});

		const cached: string[] = [];
		await manager.warmEagerServers((config) => cached.push(config.name));

		expect(connected).toEqual(["eagerly"]);
		expect(cached).toEqual(["eagerly"]);
		expect(manager.state("lazily")).toEqual({ kind: "disconnected" });
	});

	it("does not let one broken eager server stop the rest of startup", async () => {
		const manager = new McpServerManager({
			servers: new Map([
				["broken", server("broken", { lifecycle: "eager" })],
				["fine", server("fine", { lifecycle: "eager" })],
			]),
			connector: async (config) => {
				if (config.name === "broken") throw new Error("exited immediately");
				return fakeConnection();
			},
		});

		const warmed: string[] = [];
		await expect(manager.warmEagerServers((config) => warmed.push(config.name))).resolves.toBeUndefined();

		expect(warmed).toEqual(["fine"]);
		expect(manager.state("broken").kind).toBe("failed");
	});

	it("rejects a server that is not configured", async () => {
		const manager = new McpServerManager({ servers: new Map(), connector: async () => fakeConnection() });

		await expect(manager.withConnection("nope", async () => undefined)).rejects.toThrow(/not configured/i);
	});

	it("closes everything it opened", async () => {
		const connections = [fakeConnection(), fakeConnection()];
		let index = 0;
		const manager = new McpServerManager({
			servers: new Map([
				["a", server("a")],
				["b", server("b")],
			]),
			connector: async () => {
				const next = connections[index];
				index += 1;
				return next as McpConnection;
			},
		});

		await manager.withConnection("a", async () => undefined);
		await manager.withConnection("b", async () => undefined);
		await manager.closeAll();

		expect(connections.every((connection) => connection.closed)).toBe(true);
		expect(manager.state("a")).toEqual({ kind: "disconnected" });
	});

	it("does not start a second connection while the first is in flight", async () => {
		let resolve: ((connection: McpConnection) => void) | undefined;
		const connector = vi.fn(
			() =>
				new Promise<McpConnection>((r) => {
					resolve = r;
				}),
		);
		const manager = new McpServerManager({ servers: new Map([["a", server("a")]]), connector });

		const first = manager.withConnection("a", async () => "first");
		const second = manager.withConnection("a", async () => "second");
		resolve?.(fakeConnection());

		await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
		expect(connector).toHaveBeenCalledTimes(1);
	});
});
