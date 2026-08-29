import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/core/mcp/config.ts";
import { ALL_CAPABILITIES } from "../../src/core/tools/contract.ts";

describe("MCP config", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function createDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-mcp-config-test-"));
		tempDirs.push(dir);
		return dir;
	}

	function write(dir: string, name: string, contents: string): string {
		const file = path.join(dir, name);
		fs.writeFileSync(file, contents);
		return file;
	}

	function load(project?: string, global?: string) {
		return loadMcpConfig({ projectPath: project, globalPath: global });
	}

	describe("transport inference", () => {
		it("infers stdio from command", () => {
			const dir = createDir();
			const file = write(
				dir,
				".mcp.json",
				JSON.stringify({ mcpServers: { local: { command: "npx", args: ["-y", "some-server"] } } }),
			);

			const { servers } = load(file);

			expect(servers.get("local")?.transport).toEqual({
				kind: "stdio",
				command: "npx",
				args: ["-y", "some-server"],
				env: {},
				cwd: undefined,
			});
		});

		it("infers http from url", () => {
			const dir = createDir();
			const file = write(
				dir,
				".mcp.json",
				JSON.stringify({ mcpServers: { remote: { url: "https://example.com/mcp" } } }),
			);

			const { servers } = load(file);

			expect(servers.get("remote")?.transport).toEqual({
				kind: "http",
				url: "https://example.com/mcp",
				headers: {},
				bearerTokenEnv: undefined,
			});
		});

		it("parses a stock entry pasted from another host with no Apex-specific fields", () => {
			const dir = createDir();
			const file = write(
				dir,
				".mcp.json",
				'{"mcpServers":{"chrome-devtools":{"command":"npx","args":["-y","chrome-devtools-mcp@1.6.0"]}}}',
			);

			const { servers, diagnostics } = load(file);

			expect(diagnostics).toEqual([]);
			expect(servers.get("chrome-devtools")?.transport.kind).toBe("stdio");
		});
	});

	describe("precedence", () => {
		it("prefers the project entry over the global entry of the same name", () => {
			const dir = createDir();
			const project = write(
				dir,
				".mcp.json",
				JSON.stringify({ mcpServers: { shared: { command: "project-cmd" } } }),
			);
			const global = write(dir, "mcp.json", JSON.stringify({ mcpServers: { shared: { command: "global-cmd" } } }));

			const { servers } = load(project, global);
			const transport = servers.get("shared")?.transport;

			expect(transport?.kind === "stdio" && transport.command).toBe("project-cmd");
		});

		it("keeps a server that appears in only one file", () => {
			const dir = createDir();
			const project = write(dir, ".mcp.json", JSON.stringify({ mcpServers: { a: { command: "a" } } }));
			const global = write(dir, "mcp.json", JSON.stringify({ mcpServers: { b: { command: "b" } } }));

			const { servers } = load(project, global);

			expect([...servers.keys()].sort()).toEqual(["a", "b"]);
		});

		it("returns no servers when neither file exists", () => {
			const dir = createDir();

			const { servers, diagnostics } = load(path.join(dir, "missing.json"));

			expect(servers.size).toBe(0);
			expect(diagnostics).toEqual([]);
		});
	});

	describe("malformed input degrades instead of throwing", () => {
		it("reports invalid JSON and yields no servers", () => {
			const dir = createDir();
			const file = write(dir, ".mcp.json", "{ not json");

			const { servers, diagnostics } = load(file);

			expect(servers.size).toBe(0);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.path).toBe(file);
		});

		it("drops an entry with neither command nor url but keeps its siblings", () => {
			const dir = createDir();
			const file = write(
				dir,
				".mcp.json",
				JSON.stringify({ mcpServers: { broken: { env: {} }, good: { command: "ok" } } }),
			);

			const { servers, diagnostics } = load(file);

			expect([...servers.keys()]).toEqual(["good"]);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.server).toBe("broken");
		});

		it("drops an entry declaring both command and url", () => {
			const dir = createDir();
			const file = write(
				dir,
				".mcp.json",
				JSON.stringify({ mcpServers: { ambiguous: { command: "x", url: "https://example.com" } } }),
			);

			const { servers, diagnostics } = load(file);

			expect(servers.size).toBe(0);
			expect(diagnostics[0]?.server).toBe("ambiguous");
		});

		it("falls back to the default lifecycle on an unknown value", () => {
			const dir = createDir();
			const file = write(
				dir,
				".mcp.json",
				JSON.stringify({ mcpServers: { s: { command: "x", lifecycle: "nonsense" } } }),
			);

			const { servers, diagnostics } = load(file);

			expect(servers.get("s")?.lifecycle).toBe("lazy");
			expect(diagnostics).toHaveLength(1);
		});
	});

	describe("capabilities", () => {
		it("resolves an absent capability set to the full set", () => {
			const dir = createDir();
			const file = write(dir, ".mcp.json", JSON.stringify({ mcpServers: { s: { command: "x" } } }));

			const { servers } = load(file);

			expect(servers.get("s")?.capabilities).toEqual(ALL_CAPABILITIES);
		});

		it("honours a declared capability set", () => {
			const dir = createDir();
			const file = write(
				dir,
				".mcp.json",
				JSON.stringify({ mcpServers: { s: { command: "x", capabilities: ["net", "fs.read"] } } }),
			);

			const { servers } = load(file);

			expect(servers.get("s")?.capabilities).toEqual(new Set(["net", "fs.read"]));
		});

		it("drops an unknown capability name and reports it", () => {
			const dir = createDir();
			const file = write(
				dir,
				".mcp.json",
				JSON.stringify({ mcpServers: { s: { command: "x", capabilities: ["net", "teleport"] } } }),
			);

			const { servers, diagnostics } = load(file);

			expect(servers.get("s")?.capabilities).toEqual(new Set(["net"]));
			expect(diagnostics).toHaveLength(1);
		});
	});
});
