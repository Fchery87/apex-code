import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";

const cliPath = resolve(__dirname, "../../src/cli.ts");
const extensionPath = resolve(__dirname, "fixtures/credential-boundary-extension.ts");
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

function canEnforceLinuxSandbox(): boolean {
	return process.platform === "linux" && createLinuxSandboxBackend().status.kind === "enforced";
}

async function runCli(options: { args: readonly string[]; cwd: string; environment?: NodeJS.ProcessEnv }) {
	let stdout = "";
	let stderr = "";
	const child = spawn(process.execPath, [cliPath, ...options.args], {
		cwd: options.cwd,
		env: { ...process.env, ...options.environment },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("close", resolvePromise);
	});
	return { code, stdout, stderr };
}

describe.skipIf(!canEnforceLinuxSandbox())("live-agent credential handoff", () => {
	it("reads the host-owned credential file read-only through a real sandboxed CLI turn", async () => {
		const workspace = temporaryDirectory("apex-sandbox-credential-workspace-");
		const hostAgentDir = temporaryDirectory("apex-sandbox-credential-agent-");
		mkdirSync(hostAgentDir, { recursive: true });
		writeFileSync(
			join(hostAgentDir, "auth.json"),
			JSON.stringify({ "credential-boundary-test": { type: "api_key", key: "host-owned-secret" } }),
			{
				mode: 0o600,
			},
		);
		const resultPath = join(workspace, "credential-boundary-result.json");

		const result = await runCli({
			args: [
				"--print",
				"run the credential boundary test",
				"--extension",
				extensionPath,
				"--model",
				"credential-boundary-test/scripted",
				"--permission-mode",
				"bypassPermissions",
			],
			cwd: workspace,
			environment: {
				APEX_CODE_CODING_AGENT_DIR: hostAgentDir,
			},
		});

		expect(result.code, `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`).toBe(0);
		const outcome = JSON.parse(readFileSync(resultPath, "utf8")) as { readValue: string; writeOutcome: string };
		expect(outcome.readValue).toBe(
			JSON.stringify({ "credential-boundary-test": { type: "api_key", key: "host-owned-secret" } }),
		);
		expect(outcome.writeOutcome).toBe("rejected");
		// The host's own copy is unaffected by the sandboxed child's rejected write attempt.
		expect(readFileSync(join(hostAgentDir, "auth.json"), "utf8")).toBe(
			JSON.stringify({ "credential-boundary-test": { type: "api_key", key: "host-owned-secret" } }),
		);
	});
});
