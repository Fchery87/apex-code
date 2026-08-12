import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SandboxBackend, SandboxLaunch } from "./supervisor.ts";
import type { SandboxViolationStore } from "./violations.ts";

export interface LinuxSandboxBackendOptions {
	/** Injectable only for preflight tests; production uses the running platform. */
	platform?: NodeJS.Platform;
	commandExists?: (command: string) => boolean;
	violationStore?: SandboxViolationStore;
}

function commandExists(command: string): boolean {
	const result = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 1_000 });
	return result.status === 0;
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

function classifySandboxFailure(stderr: string): "filesystem" | "network" | "unknown" {
	if (/Read-only file system|Permission denied|Operation not permitted/i.test(stderr)) return "filesystem";
	if (/Network is unreachable|ENETUNREACH|EHOSTUNREACH/i.test(stderr)) return "network";
	return "unknown";
}

/**
 * Linux's deliberately small platform adapter. The sandbox starts from a read-only
 * host root and bind-mounts only the canonical workspace as writable. `--unshare-net`
 * removes all direct network interfaces for the child and every descendant.
 */
export function createLinuxSandboxBackend(options?: LinuxSandboxBackendOptions): SandboxBackend {
	const platform = options?.platform ?? process.platform;
	if (platform !== "linux") {
		return {
			status: { kind: "unavailable", reason: "OS sandbox is supported on Linux only." },
			async launch() {
				throw new Error("Linux sandbox backend is unavailable.");
			},
			async close() {},
		};
	}
	const hasCommand = options?.commandExists ?? commandExists;
	const violationStore = options?.violationStore;
	if (!hasCommand("bwrap")) {
		return {
			status: { kind: "unavailable", reason: "Bubblewrap (bwrap) is required for OS sandboxing." },
			async launch() {
				throw new Error("Linux sandbox backend is unavailable.");
			},
			async close() {},
		};
	}
	return {
		status: { kind: "enforced" },
		async launch(launch: SandboxLaunch): Promise<number> {
			const stateDirectory = join(launch.policy.workspace, ".apex-code", "sandbox-state");
			mkdirSync(stateDirectory, { recursive: true });
			const child = spawn(
				"bwrap",
				[
					"--new-session",
					"--die-with-parent",
					"--unshare-user",
					"--unshare-pid",
					"--unshare-net",
					"--ro-bind",
					"/",
					"/",
					"--bind",
					launch.policy.workspace,
					launch.policy.workspace,
					"--dev",
					"/dev",
					"--proc",
					"/proc",
					"--chdir",
					launch.policy.workspace,
					"--setenv",
					"HOME",
					stateDirectory,
					"--setenv",
					"TMPDIR",
					stateDirectory,
					"--setenv",
					"APEX_CODE_SANDBOX_ENFORCED",
					"1",
					"--",
					launch.command,
					...launch.args,
				],
				{ stdio: ["inherit", "inherit", "pipe"] },
			);
			let stderr = "";
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
				process.stderr.write(chunk);
			});
			const exitCode = await waitForExit(child);
			if (exitCode !== 0) {
				const kind = classifySandboxFailure(stderr);
				violationStore?.add({
					kind,
					command: [launch.command, ...launch.args].join(" "),
					detail:
						kind === "unknown"
							? "Sandboxed process exited unsuccessfully; inspect its stderr for the OS refusal."
							: stderr.trim(),
					timestamp: new Date(),
				});
			}
			return exitCode;
		},
		async close() {},
	};
}
