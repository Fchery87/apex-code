import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSandboxNetworkProxy, type SandboxNetworkProxy } from "./network-proxy.ts";
import type { SandboxBackend, SandboxLaunch } from "./supervisor.ts";
import type { SandboxViolationStore } from "./violations.ts";

export interface MacosSandboxBackendOptions {
	/** Injectable only for preflight tests; production uses the running platform. */
	platform?: NodeJS.Platform;
	commandExists?: (command: string) => boolean;
	violationStore?: SandboxViolationStore;
}

function sandboxExecExists(command: string): boolean {
	// sandbox-exec has no --version flag; a real, minimal profile run is the
	// standard existence-and-basic-functionality probe (see the 2b.5 prototype's
	// own positive control).
	const result = spawnSync(command, ["-p", "(version 1)(allow default)", "/usr/bin/true"], {
		stdio: "ignore",
		timeout: 2_000,
	});
	return result.status === 0;
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

/**
 * Unlike Linux's bwrap (which needs each mount ancestor declared for its bind-mount
 * tree), Seatbelt's `subpath` is recursive from a single root, so only the directory
 * containing each path is needed -- no ancestor walk.
 */
function readOnlyDirectories(paths: readonly string[]): string[] {
	return [...new Set(paths.map((path) => dirname(resolve(path))))];
}

function classifySandboxFailure(stderr: string): "filesystem" | "network" | "unknown" {
	// Confirmed empirically (2b.5 prototype): unlike Linux's bwrap, macOS Seatbelt
	// denials surface through the launched command's own generic "Operation not
	// permitted"/EPERM text for filesystem AND network refusals alike -- there is no
	// macOS-specific phrase equivalent to Linux's distinct "Network is unreachable".
	// Only sandbox-exec's own wrapper-level exec refusal (a sign our own profile
	// forgot to allow a binary, not a policy decision) is unambiguous from stderr
	// text. Anything else stays "unknown"; network-proxy.ts's own precise per-request
	// recording is the reliable "network" signal on this platform.
	if (/execvp\(\) of .* failed: Operation not permitted/i.test(stderr)) return "filesystem";
	return "unknown";
}

/**
 * macOS's platform adapter. Seatbelt (`sandbox-exec`) denies filesystem writes and
 * network access by default; the workspace is the one writable subpath, and the
 * network proxy's exact loopback port is the one network destination allowed --
 * narrower than the wildcard `localhost:*` pattern some other sandboxes use.
 */
export function createMacosSandboxBackend(options?: MacosSandboxBackendOptions): SandboxBackend {
	const platform = options?.platform ?? process.platform;
	if (platform !== "darwin") {
		return {
			status: { kind: "unavailable", reason: "OS sandbox is supported on macOS only." },
			async launch() {
				throw new Error("macOS sandbox backend is unavailable.");
			},
			async close() {},
		};
	}
	const hasCommand = options?.commandExists ?? sandboxExecExists;
	const violationStore = options?.violationStore;
	let proxy: SandboxNetworkProxy | undefined;

	if (!hasCommand("sandbox-exec")) {
		return {
			status: { kind: "unavailable", reason: "sandbox-exec (Seatbelt) is required for OS sandboxing." },
			async launch() {
				throw new Error("macOS sandbox backend is unavailable.");
			},
			async close() {},
		};
	}
	return {
		status: { kind: "enforced" },
		async launch(launch: SandboxLaunch): Promise<number> {
			const stateDirectory = join(launch.policy.workspace, ".apex-code", "sandbox-state");
			mkdirSync(stateDirectory, { recursive: true });

			const violationCountBeforeLaunch = violationStore?.totalCount ?? 0;

			proxy = await createSandboxNetworkProxy({
				tcpHost: "127.0.0.1",
				allowedHosts: launch.policy.allowedHosts,
				violationStore,
			});
			const proxyPort = proxy.port as number;

			const readOnlyDirs = readOnlyDirectories([process.execPath, launch.command, ...(launch.readOnlyPaths ?? [])]);

			const profileLines = [
				"(version 1)",
				// bsd.sb's baseline is broader than Linux's opt-in bind-mount model --
				// a real gap this design accepts, documented in the spec's fourth
				// amendment -- but it is the only combination the 2b.5 prototype found
				// that lets a normal Unix child process (dyld, /bin/sh) actually start.
				'(import "bsd.sb")',
				"(allow process-exec*)",
				...readOnlyDirs.map((_, index) => `(allow file-read* (subpath (param "RO_${index}")))`),
				"(deny file-write*)",
				'(allow file-write* (subpath (param "WORKSPACE")))',
				"(deny network*)",
				'(allow network-outbound (remote ip (param "PROXY_ADDR")))',
			];
			const profilePath = join(stateDirectory, "profile.sb");
			writeFileSync(profilePath, profileLines.join("\n"));

			const params: string[] = [];
			readOnlyDirs.forEach((dir, index) => {
				params.push("-D", `RO_${index}=${dir}`);
			});
			params.push("-D", `WORKSPACE=${launch.policy.workspace}`);
			params.push("-D", `PROXY_ADDR=localhost:${proxyPort}`);

			const child = spawn("sandbox-exec", ["-f", profilePath, ...params, "--", launch.command, ...launch.args], {
				env: {
					...launch.environment,
					HOME: launch.environment?.HOME ?? stateDirectory,
					TMPDIR: launch.environment?.TMPDIR ?? stateDirectory,
					HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
					HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
				},
				stdio: ["inherit", "inherit", "pipe"],
			});
			let stderr = "";
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
				process.stderr.write(chunk);
			});
			const exitCode = await waitForExit(child);
			await proxy?.close();
			const proxyAlreadyRecordedAViolation = (violationStore?.totalCount ?? 0) > violationCountBeforeLaunch;
			if (exitCode !== 0 && !proxyAlreadyRecordedAViolation) {
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
		async close() {
			await proxy?.close();
		},
	};
}
