import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";

const cliPath = resolve(__dirname, "../../src/cli.ts");
const extensionPath = resolve(__dirname, "fixtures/boundary-extension.ts");
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
		env: { ...process.env, ...options.environment, PI_OFFLINE: "1" },
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

describe.skipIf(!canEnforceLinuxSandbox())("live-agent OS sandbox boundary", () => {
	it("constrains a native write and a bash descendant in the same sandboxed child tree", async () => {
		const workspace = temporaryDirectory("apex-sandbox-live-agent-");
		const outsideBash = join(dirname(workspace), `live-agent-bash-${Date.now()}.txt`);
		const outsideWrite = join(dirname(workspace), `live-agent-write-${Date.now()}.txt`);

		const result = await runCli({
			args: [
				"--print",
				"run the boundary test",
				"--extension",
				extensionPath,
				"--model",
				"boundary-test/scripted",
				"--permission-mode",
				"bypassPermissions",
			],
			cwd: workspace,
			environment: {
				APEX_BOUNDARY_TEST_OUTSIDE_BASH: outsideBash,
				APEX_BOUNDARY_TEST_OUTSIDE_WRITE: outsideWrite,
			},
		});

		expect(result.code, `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`).toBe(0);
		expect(existsSync(outsideBash)).toBe(false);
		expect(existsSync(outsideWrite)).toBe(false);
	});
});
