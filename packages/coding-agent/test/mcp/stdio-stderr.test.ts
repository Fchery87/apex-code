import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx/esm")).href;
const PROBE = "APEX-STDERR-PROBE-7c1e";

/**
 * Connects to a stdio server that writes PROBE to stderr and exits. The connect runs in a
 * child process, so the test can capture what that child's stderr receives. Asserts the
 * child exited cleanly, so a harness that fails to start cannot pass by writing nothing.
 */
function connectToNoisyServer(): { stderr: string; agentDir: string } {
	const scratch = mkdtempSync(join(tmpdir(), "apex-mcp-stderr-"));
	const agentDir = join(scratch, "agent");
	const serverScript = join(scratch, "noisy-server.cjs");
	const harness = join(scratch, "harness.mts");
	const connectorUrl = pathToFileURL(join(packageRoot, "src", "core", "mcp", "connector.ts")).href;
	writeFileSync(serverScript, `process.stderr.write(${JSON.stringify(`${PROBE}\n`)});\nprocess.exit(1);\n`);
	writeFileSync(
		harness,
		`import { connectMcpServer } from ${JSON.stringify(connectorUrl)};
const server = {
	name: "probe",
	transport: { kind: "stdio", command: process.execPath, args: [${JSON.stringify(serverScript)}], env: {}, cwd: undefined },
	capabilities: new Set(),
	lifecycle: "lazy",
	idleTimeoutMinutes: 10,
};
await connectMcpServer(server).catch(() => undefined);
await new Promise((resolve) => setTimeout(resolve, 500));
`,
	);
	const result = spawnSync(process.execPath, ["--import", tsxLoader, harness], {
		cwd: scratch,
		env: { ...process.env, APEX_CODE_CODING_AGENT_DIR: agentDir, APEX_CODE_OFFLINE: "1" },
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.status !== 0) throw new Error(`harness failed (status ${result.status}): ${result.stderr}`);
	return { stderr: result.stderr, agentDir };
}

describe("MCP stdio server stderr", () => {
	it("does not write a server's stderr to the terminal the TUI is drawing on", () => {
		const { stderr } = connectToNoisyServer();
		expect(stderr).not.toContain(PROBE);
	});

	it("keeps a server's stderr in a per-server log under the agent directory", () => {
		const { agentDir } = connectToNoisyServer();
		const logDir = join(agentDir, "mcp", "logs");
		expect(existsSync(logDir)).toBe(true);
		const logged = readdirSync(logDir)
			.map((file) => readFileSync(join(logDir, file), "utf8"))
			.join("");
		expect(logged).toContain(PROBE);
	});
});
