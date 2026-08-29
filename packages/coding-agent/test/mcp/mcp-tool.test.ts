import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createMcpToolDefinition, MCP_TOOL_NAME } from "../../src/core/mcp/mcp-tool.ts";
import { McpMetadataCache } from "../../src/core/mcp/metadata-cache.ts";
import { McpServerManager } from "../../src/core/mcp/server-manager.ts";
import type { CachedTool, McpConnection, McpServerConfig } from "../../src/core/mcp/types.ts";

function server(name: string): McpServerConfig {
	return {
		name,
		transport: { kind: "stdio", command: name, args: [], env: {}, cwd: undefined },
		capabilities: new Set(["net"]),
		lifecycle: "lazy",
		idleTimeoutMinutes: 10,
	};
}

function tool(server: string, name: string, description: string): CachedTool {
	return { server, name, description, inputSchema: { type: "object", properties: {} } };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

describe("mcp proxy tool", () => {
	const tempDirs: string[] = [];
	const previousAgentDir = process.env[ENV_AGENT_DIR];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		vi.restoreAllMocks();
	});

	function setup(options: { connector?: () => Promise<McpConnection> } = {}) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-mcp-tool-test-"));
		tempDirs.push(dir);
		process.env[ENV_AGENT_DIR] = dir;

		const github = server("github");
		const files = server("files");
		const servers = new Map([
			["github", github],
			["files", files],
		]);

		const cache = new McpMetadataCache();
		cache.set(github, [
			tool("github", "create_issue", "Open a new issue on a repository"),
			tool("github", "list_repos", "List repositories for the user"),
		]);
		cache.set(files, [tool("files", "read_file", "Read a file from disk")]);
		cache.save();

		const manager = new McpServerManager({
			servers,
			connector:
				options.connector ??
				(async () => {
					throw new Error("connector should not be reached");
				}),
		});

		return { definition: createMcpToolDefinition({ servers, cache: new McpMetadataCache(), manager }), servers };
	}

	const run = (definition: ReturnType<typeof createMcpToolDefinition>, params: unknown) =>
		definition.execute("call-1", params as never, new AbortController().signal, () => {}, undefined as never);

	it("is named so the model can address it", () => {
		expect(MCP_TOOL_NAME).toBe("mcp");
		expect(setup().definition.name).toBe("mcp");
	});

	it("searches cached tools across every server", async () => {
		const { definition } = setup();

		const result = await run(definition, { search: "issue" });

		expect(textOf(result)).toContain("github:create_issue");
		expect(textOf(result)).not.toContain("files:read_file");
	});

	it("restricts a search to one server when asked", async () => {
		const { definition } = setup();

		const result = await run(definition, { search: "list", server: "github" });

		expect(textOf(result)).toContain("github:list_repos");
	});

	it("lists a server's tools when given a server alone", async () => {
		const { definition } = setup();

		const result = await run(definition, { server: "files" });

		expect(textOf(result)).toContain("files:read_file");
		expect(textOf(result)).not.toContain("github:");
	});

	it("describes one tool's input schema", async () => {
		const { definition } = setup();

		const result = await run(definition, { describe: "github:create_issue" });
		const text = textOf(result);

		expect(text).toContain("create_issue");
		expect(text).toContain("Open a new issue");
		expect(text).toContain("properties");
	});

	it("searches and describes with spawning made fatal, proving no server is contacted", async () => {
		const { definition } = setup();
		const childProcess = require("node:child_process") as Record<string, unknown>;
		const originals = { spawn: childProcess.spawn, spawnSync: childProcess.spawnSync };
		const explode = () => {
			throw new Error("metadata actions must never start a server");
		};
		childProcess.spawn = explode;
		childProcess.spawnSync = explode;

		try {
			expect(textOf(await run(definition, { search: "file" }))).toContain("files:read_file");
			expect(textOf(await run(definition, { describe: "files:read_file" }))).toContain("read_file");
		} finally {
			childProcess.spawn = originals.spawn;
			childProcess.spawnSync = originals.spawnSync;
		}
	});

	it("calls a tool through the server manager", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const { definition } = setup({
			connector: async () => ({
				listTools: async () => [],
				callTool: async (name, args) => {
					calls.push({ name, args });
					return { content: [{ type: "text", text: "issue #1 created" }] };
				},
				close: async () => undefined,
			}),
		});

		const result = await run(definition, { tool: "github:create_issue", args: { title: "hi" } });

		expect(calls).toEqual([{ name: "create_issue", args: { title: "hi" } }]);
		expect(textOf(result)).toContain("issue #1 created");
	});

	it("clears cached tools when a server reports it now has none", async () => {
		const { definition } = setup({
			connector: async () => ({
				listTools: async () => [],
				callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
				close: async () => undefined,
			}),
		});

		await run(definition, { tool: "github:create_issue", args: {} });
		const after = await run(definition, { server: "github" });

		expect(textOf(after)).not.toContain("github:create_issue");
	});

	it("names close matches instead of failing opaquely on an unknown tool", async () => {
		const { definition } = setup();

		const result = await run(definition, { describe: "github:create_isue" });

		expect(textOf(result)).toContain("create_issue");
	});

	it("reports an unknown server rather than searching for it", async () => {
		const { definition } = setup();

		const result = await run(definition, { server: "nope" });

		expect(textOf(result)).toMatch(/not configured|unknown server/i);
	});

	it("surfaces a failed server's state instead of retrying", async () => {
		let attempts = 0;
		const { definition } = setup({
			connector: async () => {
				attempts += 1;
				throw new Error("server exited immediately");
			},
		});

		const first = await run(definition, { tool: "github:create_issue", args: {} });
		const second = await run(definition, { tool: "github:create_issue", args: {} });

		expect(textOf(first)).toContain("server exited immediately");
		expect(textOf(second)).toContain("server exited immediately");
		expect(attempts).toBe(1);
	});

	it("rejects a call naming no action", async () => {
		const { definition } = setup();

		expect(textOf(await run(definition, {}))).toMatch(/search|describe|tool/i);
	});

	it("keeps its description inside the prompt budget it promises", () => {
		expect(setup().definition.description.length).toBeLessThanOrEqual(600);
	});

	it("declares a contract, so it is never UNCLASSIFIED", () => {
		const { definition } = setup();

		expect(definition.contract.context.deferSchema).toBe(true);
		expect(definition.contract.permission.ruleForCall({ tool: "github:create_issue" } as never)).toBe(
			"Mcp(github:create_issue)",
		);
	});
});
