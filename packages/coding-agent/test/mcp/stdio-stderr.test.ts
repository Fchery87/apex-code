import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx/esm")).href;
const PROBE = "APEX-STDERR-PROBE-7c1e";

const HANDSHAKE = `const readline = require("node:readline");
process.stderr.write(${JSON.stringify(`${PROBE}\n`)});
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.method === "initialize") {
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "probe", version: "0" } } }) + "\\n");
	} else if (message.id !== undefined) {
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
	}
});
`;

/**
 * Connects to a stdio server that writes PROBE to stderr. The connect runs in a child
 * process, so the test can capture what that child's stderr receives. Asserts the child
 * exited cleanly, so a harness that fails to start cannot pass by writing nothing.
 * `requireConnected` makes the harness fail unless the MCP handshake completes.
 */
function connectToNoisyServer(
	prepare?: (agentDir: string) => void,
	requireConnected = false,
): { stderr: string; agentDir: string } {
	const scratch = mkdtempSync(join(tmpdir(), "apex-mcp-stderr-"));
	const agentDir = join(scratch, "agent");
	const serverScript = join(scratch, "noisy-server.cjs");
	const harness = join(scratch, "harness.mts");
	const connectorUrl = pathToFileURL(join(packageRoot, "src", "core", "mcp", "connector.ts")).href;
	writeFileSync(
		serverScript,
		requireConnected ? HANDSHAKE : `process.stderr.write(${JSON.stringify(`${PROBE}\n`)});\nprocess.exit(1);\n`,
	);
	writeFileSync(
		harness,
		`import { writeFileSync } from "node:fs";
import { connectMcpServer } from ${JSON.stringify(connectorUrl)};
const server = {
	name: "probe",
	transport: { kind: "stdio", command: process.execPath, args: [${JSON.stringify(serverScript)}], env: {}, cwd: undefined },
	capabilities: new Set(),
	lifecycle: "lazy",
	idleTimeoutMinutes: 10,
};
try {
	const connection = await connectMcpServer(server);
	writeFileSync(${JSON.stringify(join(scratch, "result.txt"))}, "connected\\n");
	await connection.close();
} catch (error) {
	writeFileSync(${JSON.stringify(join(scratch, "result.txt"))}, "rejected: " + (error instanceof Error ? error.stack : String(error)));
	if (${requireConnected}) process.exitCode = 1;
}
await new Promise((resolve) => setTimeout(resolve, 500));
`,
	);
	prepare?.(agentDir);
	const result = spawnSync(process.execPath, ["--import", tsxLoader, harness], {
		cwd: scratch,
		env: { ...process.env, APEX_CODE_CODING_AGENT_DIR: agentDir, APEX_CODE_OFFLINE: "1" },
		encoding: "utf8",
		timeout: 60_000,
	});
	if (result.status !== 0) {
		const recorded = existsSync(join(scratch, "result.txt")) ? readFileSync(join(scratch, "result.txt"), "utf8") : "";
		throw new Error(`harness failed (status ${result.status}): ${result.stderr}\n${recorded}`);
	}
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

	// Node on Windows reports file type bits, not the Unix mode chmod set.
	it.skipIf(process.platform === "win32")("keeps the log directory and file readable by the owner only", async () => {
		const { agentDir } = connectToNoisyServer();
		const logDir = join(agentDir, "mcp", "logs");
		const [file] = readdirSync(logDir);
		const logPath = join(logDir, file);
		const deadline = Date.now() + 2_000;
		while ((statSync(logPath).mode & 0o077) !== 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(statSync(logDir).mode & 0o077).toBe(0);
		expect(statSync(logPath).mode & 0o077).toBe(0);
	});

	it("still connects when the log directory cannot be created", () => {
		const { stderr } = connectToNoisyServer((agentDir) => {
			const logs = join(agentDir, "mcp", "logs");
			mkdirSync(join(agentDir, "mcp"), { recursive: true });
			writeFileSync(logs, "not a directory\n");
			chmodSync(logs, 0o600);
		}, true);
		expect(stderr).not.toContain(PROBE);
		expect(stderr).not.toMatch(/EEXIST|ENOTDIR|EACCES/);
	});

	it("stops appending once the log reaches its limit", () => {
		const { agentDir } = connectToNoisyServer((agentDir) => {
			const logDir = join(agentDir, "mcp", "logs");
			mkdirSync(logDir, { recursive: true });
			writeFileSync(join(logDir, "probe.log"), Buffer.alloc(1024 * 1024, "x"));
		}, true);
		expect(statSync(join(agentDir, "mcp", "logs", "probe.log")).size).toBe(1024 * 1024);
	});
});
