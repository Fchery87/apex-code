import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createMcpRuntime } from "../../src/core/mcp/runtime.ts";
import type { CachedTool, McpConnection, McpConnector } from "../../src/core/mcp/types.ts";

let root: string;
let agentDir: string;
const savedEnv = process.env[ENV_AGENT_DIR];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "apex-mcp-cold-"));
	agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	// The global config sits beside the agent directory; the cache sits under it.
	writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }));
	process.env[ENV_AGENT_DIR] = agentDir;
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedEnv;
	rmSync(root, { recursive: true, force: true });
});

function connector(listed: CachedTool[]): { connect: McpConnector; counts: { connects: number } } {
	const counts = { connects: 0 };
	const connect: McpConnector = async (): Promise<McpConnection> => {
		counts.connects++;
		return {
			listTools: async () => listed,
			callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
			close: async () => {},
		};
	};
	return { connect, counts };
}

const docsSearch: CachedTool = {
	server: "docs",
	name: "search",
	description: "Search the docs",
	inputSchema: { type: "object" },
};

describe("cold MCP discovery (HR.14)", () => {
	it("lists a lazy server with no cache entry at startup, so search finds its tool before any call", async () => {
		const fake = connector([docsSearch]);
		const runtime = createMcpRuntime(root, fake.connect, { projectTrusted: false, agentDir });
		expect(runtime).toBeDefined();
		await runtime!.warm();
		expect(runtime!.cache.all().map((tool) => `${tool.server}:${tool.name}`)).toEqual(["docs:search"]);
		await runtime!.close();
	});

	it("reports which servers it started, so the session can tell the user", async () => {
		const runtime = createMcpRuntime(root, connector([docsSearch]).connect, { projectTrusted: false, agentDir });
		const started = await runtime!.warm();
		expect(started).toEqual(["docs"]);
		await runtime!.close();
	});

	it("runs once per server: a second session with a warm cache starts nothing", async () => {
		const first = createMcpRuntime(root, connector([docsSearch]).connect, { projectTrusted: false, agentDir });
		await first!.warm();
		await first!.close();

		const second = connector([docsSearch]);
		const runtime = createMcpRuntime(root, second.connect, { projectTrusted: false, agentDir });
		expect(await runtime!.warm()).toEqual([]);
		expect(second.counts.connects).toBe(0);
		await runtime!.close();
	});
});
