/**
 * LSP.3 — spawn environment. Proves that a server child spawned through the real
 * `LspPool` (not a stand-in) inherits the sandboxed launch's private state paths for
 * `HOME`, `TMPDIR`, and the XDG config/cache/data/state variables, exactly as any
 * other child of an already-sandboxed apex-code process does (ADR 0005; see
 * `core/sandbox/cli-launch.ts`'s `buildSandboxedCliLaunch`). `LspPool`/`LspClient`
 * pass no `env` override in production, so this is provable with zero LSP-specific
 * environment code: the property under test belongs to the sandbox launch, and LSP
 * only needs to not get in its way.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchSandboxedCli } from "../../src/core/sandbox/cli-supervisor.ts";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";

function canEnforceLinuxSandbox(): boolean {
	return process.platform === "linux" && createLinuxSandboxBackend().status.kind === "enforced";
}

// The probe script imports the real `core/lsp/{pool,registry}.ts` by relative path,
// so its whole module graph (repo `src/`, hoisted `node_modules`) must be visible
// inside the sandbox. `/home` is replaced with an empty tmpfs there (ADR 0005: denied
// host-home), and this repository lives under `/home`, so it is exposed explicitly --
// unlike a real language server's own installation, which is not this test's concern.
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const PROBE_SCRIPT = join(import.meta.dirname, "fixtures/lsp-pool-probe.ts");

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-sandbox-lsp-env-"));
	directories.push(directory);
	return directory;
}

describe.skipIf(!canEnforceLinuxSandbox())("LSP server spawn environment inside the sandbox", () => {
	it("a server child spawned through the real LspPool sees the sandbox's private state paths, not the host's", async () => {
		const cwd = workspace();
		const reportPath = join(cwd, "env-report.json");
		let stderr = "";

		const code = await launchSandboxedCli({
			command: process.execPath,
			args: [PROBE_SCRIPT, "env", reportPath],
			environment: {},
			workspace: cwd,
			readOnlyPaths: [join(REPO_ROOT, "package.json")],
			dependencies: {
				stderr: {
					write: (message) => {
						stderr += message;
						return true;
					},
				},
			},
		});

		expect(code, stderr).toBe(0);
		const serverEnv = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, string | undefined>;

		// Matches buildSandboxedCliLaunch's own derivation exactly (cli-launch.ts):
		// workspace/.apex-code/sandbox-state, and its config/cache/data/state children.
		const sandboxStateDirectory = join(cwd, ".apex-code", "sandbox-state");
		expect(serverEnv.HOME).toBe(sandboxStateDirectory);
		expect(serverEnv.TMPDIR).toBe(sandboxStateDirectory);
		expect(serverEnv.XDG_CONFIG_HOME).toBe(join(sandboxStateDirectory, "config"));
		expect(serverEnv.XDG_CACHE_HOME).toBe(join(sandboxStateDirectory, "cache"));
		expect(serverEnv.XDG_DATA_HOME).toBe(join(sandboxStateDirectory, "data"));
		expect(serverEnv.XDG_STATE_HOME).toBe(join(sandboxStateDirectory, "state"));

		// The actual claim: private sandbox paths, not this host's real values.
		expect(serverEnv.HOME).not.toBe(process.env.HOME);
	});
});
