import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";
import { createMacosSandboxBackend } from "../../src/core/sandbox/macos-backend.ts";

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

function canEnforceSandbox(): boolean {
	// The handoff is a property of whichever backend enforces on this platform, so the
	// live proof runs on macOS CI as well as Linux -- the spec requires both.
	const backend = process.platform === "darwin" ? createMacosSandboxBackend() : createLinuxSandboxBackend();
	return backend.status.kind === "enforced";
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

/**
 * These tests spawn a whole CLI, which transpiles its module graph in a cold worker before
 * it does anything. Warm they take seconds; in a parallel suite run on a loaded machine
 * they have repeatedly crossed the 30s default and then passed in isolation, which is the
 * load-flake signature Phase 2b's roadmap entry already records for CLI-spawning files.
 * The cost is real rather than a hang, so the timeout is the thing that was wrong.
 */
const CLI_SPAWN_TIMEOUT_MS = 120_000;

describe.skipIf(!canEnforceSandbox())("live-agent credential handoff", { timeout: CLI_SPAWN_TIMEOUT_MS }, () => {
	it("creates and writes the canonical host credential file on the first sandbox credential mutation", async () => {
		const workspace = temporaryDirectory("apex-sandbox-fresh-credential-workspace-");
		const hostAgentDir = temporaryDirectory("apex-sandbox-fresh-credential-agent-");
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
			environment: { APEX_CODE_CODING_AGENT_DIR: hostAgentDir },
		});

		expect(result.code, `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`).toBe(0);
		const hostAuthPath = join(hostAgentDir, "auth.json");
		expect(JSON.parse(readFileSync(hostAuthPath, "utf8"))).toMatchObject({
			"credential-boundary-test": { type: "api_key", key: "written-through-channel" },
		});
	}, 180_000);

	// One real sandboxed CLI turn: ~19s alone, longer under the parallel load of the
	// full sandbox directory. The 30s default measured the machine, not the boundary.
	it("reads read-only, refuses direct writes, and writes literals through the channel", async () => {
		const workspace = temporaryDirectory("apex-sandbox-credential-workspace-");
		const hostAgentDir = temporaryDirectory("apex-sandbox-credential-agent-");
		mkdirSync(hostAgentDir, { recursive: true });
		const originalCredential = { type: "api_key", key: "host-owned-secret" };
		writeFileSync(
			join(hostAgentDir, "auth.json"),
			JSON.stringify({ "credential-boundary-test": originalCredential }),
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
		const outcome = JSON.parse(readFileSync(resultPath, "utf8")) as {
			readValue: string;
			writeOutcome: string;
			literalWrite: string;
			literalWriteDetail?: string;
			commandWrite: string;
		};

		// The read path is unchanged: the host-projected file, verbatim.
		expect(outcome.readValue).toBe(JSON.stringify({ "credential-boundary-test": originalCredential }));

		// The mount stays read-only: a direct filesystem write is still refused, and
		// the channel is the only way out.
		expect(outcome.writeOutcome).toBe("rejected");

		// A literal credential written through the channel lands in the host file.
		expect(outcome.literalWrite, outcome.literalWriteDetail).toBe("succeeded");
		const hostFile = JSON.parse(readFileSync(join(hostAgentDir, "auth.json"), "utf8")) as Record<
			string,
			{ type?: string; key?: string }
		>;
		expect(hostFile["credential-boundary-test"]).toEqual({ type: "api_key", key: "written-through-channel" });
		expect(JSON.stringify(hostFile)).not.toContain("tampered-from-sandbox");

		// The content constraint holds through the real channel: a `!command` value is
		// refused and never reaches the host file.
		expect(outcome.commandWrite).toBe("rejected");
		expect(hostFile["credential-boundary-command-test"]).toBeUndefined();

		// Both the accepted write and the refusal are audited in the violation tail
		// the supervisor prints on exit.
		expect(result.stderr).toContain("credential-write credential-boundary-test");
		expect(result.stderr).toContain("credential-write credential-boundary-command-test");
		expect(result.stderr).toContain("Refused");
	}, 180_000);
});
