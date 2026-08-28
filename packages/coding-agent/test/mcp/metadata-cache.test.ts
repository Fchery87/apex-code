import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { McpMetadataCache, serverCacheKey } from "../../src/core/mcp/metadata-cache.ts";
import type { CachedTool, McpServerConfig } from "../../src/core/mcp/types.ts";

function stdioServer(name: string, command: string, args: string[] = []): McpServerConfig {
	return {
		name,
		transport: { kind: "stdio", command, args, env: {}, cwd: undefined },
		capabilities: new Set(["net"]),
		lifecycle: "lazy",
		idleTimeoutMinutes: 10,
	};
}

function tool(server: string, name: string): CachedTool {
	return { server, name, description: `${name} description`, inputSchema: { type: "object" } };
}

describe("MCP metadata cache", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
	});

	function agentDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-mcp-cache-test-"));
		tempDirs.push(dir);
		process.env[ENV_AGENT_DIR] = dir;
		return dir;
	}

	it("round-trips tools for a server", () => {
		agentDir();
		const server = stdioServer("github", "npx", ["-y", "github-mcp"]);

		const cache = new McpMetadataCache();
		cache.set(server, [tool("github", "create_issue"), tool("github", "list_repos")]);
		cache.save();

		const reloaded = new McpMetadataCache();
		expect(reloaded.get(server).map((entry) => entry.name)).toEqual(["create_issue", "list_repos"]);
	});

	it("keys on the launch spec, so an upgraded server does not read stale entries", () => {
		agentDir();
		const before = stdioServer("github", "npx", ["-y", "github-mcp@1.0.0"]);
		const after = stdioServer("github", "npx", ["-y", "github-mcp@2.0.0"]);

		expect(serverCacheKey(before)).not.toBe(serverCacheKey(after));

		const cache = new McpMetadataCache();
		cache.set(before, [tool("github", "old_tool")]);

		expect(cache.get(before).map((entry) => entry.name)).toEqual(["old_tool"]);
		expect(cache.get(after)).toEqual([]);
	});

	it("gives the same key to the same launch spec regardless of key order", () => {
		agentDir();
		const a = stdioServer("s", "cmd", ["one", "two"]);
		const b: McpServerConfig = { ...a, capabilities: new Set(["exec"]), idleTimeoutMinutes: 99 };

		expect(serverCacheKey(a)).toBe(serverCacheKey(b));
	});

	it("answers reads with no server process, proven by making spawning fatal", () => {
		agentDir();
		const server = stdioServer("github", "npx", ["-y", "github-mcp"]);
		const seeded = new McpMetadataCache();
		seeded.set(server, [tool("github", "create_issue")]);
		seeded.save();

		const childProcess = require("node:child_process") as Record<string, unknown>;
		const originals = { spawn: childProcess.spawn, spawnSync: childProcess.spawnSync };
		const explode = () => {
			throw new Error("a cache read must never start a server");
		};
		childProcess.spawn = explode;
		childProcess.spawnSync = explode;

		try {
			const cache = new McpMetadataCache();
			expect(cache.get(server)).toHaveLength(1);
			expect(cache.all()).toHaveLength(1);
		} finally {
			childProcess.spawn = originals.spawn;
			childProcess.spawnSync = originals.spawnSync;
		}
	});

	it("treats a corrupt cache file as empty rather than failing", () => {
		const dir = agentDir();
		fs.mkdirSync(path.join(dir, "mcp"), { recursive: true });
		fs.writeFileSync(path.join(dir, "mcp", "metadata.json"), "{ not json");

		const cache = new McpMetadataCache();

		expect(cache.all()).toEqual([]);
		expect(() => cache.set(stdioServer("s", "x"), [tool("s", "t")])).not.toThrow();
	});

	it("writes atomically, leaving no temporary file behind", () => {
		const dir = agentDir();
		const cache = new McpMetadataCache();
		cache.set(stdioServer("s", "x"), [tool("s", "t")]);
		cache.save();

		const files = fs.readdirSync(path.join(dir, "mcp"));

		expect(files).toEqual(["metadata.json"]);
	});

	it("drops cached entries for servers that are no longer configured", () => {
		agentDir();
		const kept = stdioServer("kept", "a");
		const removed = stdioServer("removed", "b");
		const seeded = new McpMetadataCache();
		seeded.set(kept, [tool("kept", "t")]);
		seeded.set(removed, [tool("removed", "t")]);
		seeded.save();

		const cache = new McpMetadataCache();
		cache.prune([kept]);
		cache.save();

		expect(new McpMetadataCache().all().map((entry) => entry.server)).toEqual(["kept"]);
	});
});
