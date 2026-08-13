import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";

const cliPath = resolve(__dirname, "../../src/cli.ts");
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

async function runCli(options: { args: readonly string[]; cwd: string; environment?: NodeJS.ProcessEnv }) {
	let stderr = "";
	const child = spawn(process.execPath, [cliPath, ...options.args], {
		cwd: options.cwd,
		env: { ...process.env, ...options.environment, PI_OFFLINE: "1" },
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("close", resolvePromise);
	});
	return { code, stderr };
}

describe("sandboxed public CLI", () => {
	it("runs the normal child entry and keeps agent state inside the workspace", async () => {
		const workspace = temporaryDirectory("apex-sandbox-cli-process-");
		const hostAgentDirectory = join(temporaryDirectory("apex-sandbox-host-agent-"), "agent");

		const result = await runCli({
			args: ["--print", "hello", "--permission-mode", "plan", "--model", "missing-sandbox-model"],
			cwd: workspace,
			environment: { [ENV_AGENT_DIR]: hostAgentDirectory },
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Model "missing-sandbox-model" not found');
		expect(existsSync(hostAgentDirectory)).toBe(false);
		expect(readdirSync(join(workspace, ".apex-code", "sandbox-agent"))).toEqual(
			expect.arrayContaining(["auth.json", "models-store.json"]),
		);
	});

	it("fails closed before executing a normal agent session when the platform sandbox tool is unavailable", async () => {
		const workspace = temporaryDirectory("apex-sandbox-cli-unavailable-");
		const result = await runCli({
			args: ["--print", "hello", "--permission-mode", "plan"],
			cwd: workspace,
			environment: { PATH: "/definitely-missing" },
		});

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("OS sandbox is not enforcing this agent session");
		expect(result.stderr).toContain(
			process.platform === "darwin" ? "sandbox-exec (Seatbelt) is required" : "Bubblewrap (bwrap) is required",
		);
	});
});
