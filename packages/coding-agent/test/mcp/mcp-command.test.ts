import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMcpCommand } from "../../src/cli/mcp-command.ts";
import { authorizeConfiguredServer } from "../../src/core/mcp/oauth/authorize.ts";
import type { McpOAuthFlowOptions } from "../../src/core/mcp/oauth/flow.ts";

describe("runMcpCommand", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	const logLines: string[] = [];
	const errorLines: string[] = [];

	beforeEach(() => {
		logLines.splice(0);
		errorLines.splice(0);
		logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => logLines.push(String(line)));
		errorSpy = vi.spyOn(console, "error").mockImplementation((line: unknown) => errorLines.push(String(line)));
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		process.exitCode = undefined;
	});

	function writeConfig(contents: unknown): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-mcp-auth-test-"));
		fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(contents));
		return dir;
	}

	it("does not consume unrelated commands", async () => {
		expect(await runMcpCommand(["auth", "check"])).toBe(false);
	});

	it("prints usage for bare mcp and mcp help", async () => {
		expect(await runMcpCommand(["mcp"])).toBe(true);
		expect(logLines.join("\n")).toContain("apex-code mcp auth <server>");
		expect(await runMcpCommand(["mcp", "help"])).toBe(true);
	});

	it("rejects an unknown subcommand and a missing server name", async () => {
		await runMcpCommand(["mcp", "list"]);
		expect(process.exitCode).toBe(1);
		await runMcpCommand(["mcp", "auth"]);
		expect(process.exitCode).toBe(1);
		expect(errorLines.join("\n")).toContain("requires a server name");
	});

	it("reports an unconfigured server with the configured names", async () => {
		const dir = writeConfig({ mcpServers: { github: { url: "https://github.example/mcp", auth: "oauth" } } });
		try {
			await runMcpCommand(["mcp", "auth", "missing"], { cwd: dir });
			expect(process.exitCode).toBe(1);
			expect(errorLines.join("\n")).toContain('MCP server "missing" is not configured');
			expect(errorLines.join("\n")).toContain("github");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails a stdio server and an HTTP server without auth: oauth, naming the fix", async () => {
		const dir = writeConfig({
			mcpServers: {
				local: { command: "npx", args: ["-y", "x"] },
				remote: { url: "https://example.com/mcp", bearerTokenEnv: "T" },
			},
		});
		try {
			await runMcpCommand(["mcp", "auth", "local"], { cwd: dir });
			expect(process.exitCode).toBe(1);
			expect(errorLines.join("\n")).toContain("stdio server");

			process.exitCode = undefined;
			await runMcpCommand(["mcp", "auth", "remote"], { cwd: dir });
			expect(process.exitCode).toBe(1);
			expect(errorLines.join("\n")).toContain('"auth": "oauth"');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs the injected flow for an OAuth server and reports success", async () => {
		const dir = writeConfig({ mcpServers: { github: { url: "https://github.example/mcp", auth: "oauth" } } });
		try {
			const flow = vi.fn(async (_options: { serverName: string; serverUrl: string }) => ({
				expiresAt: 1_800_000_000_000,
			}));
			const openBrowser = vi.fn();
			const consumed = await runMcpCommand(["mcp", "auth", "github"], { cwd: dir, openBrowser, flow });
			expect(consumed).toBe(true);
			expect(process.exitCode).toBeUndefined();
			expect(flow).toHaveBeenCalledTimes(1);
			expect(flow.mock.calls[0]![0]!.serverName).toBe("github");
			expect(flow.mock.calls[0]![0]!.serverUrl).toBe("https://github.example/mcp");
			expect(logLines.join("\n")).toContain('Authorized "github"');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("authorizeConfiguredServer", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	const lines: string[] = [];
	const tempDirs: string[] = [];

	beforeEach(() => {
		lines.splice(0);
		logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => lines.push(String(line)));
	});

	afterEach(() => {
		logSpy.mockRestore();
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function writeConfig(contents: unknown): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-mcp-auth-test-"));
		tempDirs.push(dir);
		fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(contents));
		return dir;
	}

	it("passes the server identity, a credential store, and the openers to the flow", async () => {
		const dir = writeConfig({ mcpServers: { github: { url: "https://github.example/mcp", auth: "oauth" } } });
		const flow = vi.fn(async (options: McpOAuthFlowOptions) => {
			options.deps?.print?.("Authorize by opening: https://as.example/authorize");
			return { expiresAt: 1_800_000_000_000 };
		});
		const openBrowser = vi.fn();

		await authorizeConfiguredServer({
			serverName: "github",
			cwd: dir,
			openBrowser,
			flow,
			log: (line) => lines.push(line),
		});

		expect(flow).toHaveBeenCalledTimes(1);
		const call = flow.mock.calls[0]![0]!;
		expect(call.serverName).toBe("github");
		expect(call.serverUrl).toBe("https://github.example/mcp");
		expect(call.credentials).toBeTruthy();
		expect(lines.join("\n")).toContain('Authorized "github"');
	});
});
