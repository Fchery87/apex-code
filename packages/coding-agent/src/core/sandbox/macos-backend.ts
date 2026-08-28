import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHostApprover } from "./host-approval.ts";
import { createSandboxNetworkProxy, type SandboxNetworkProxy } from "./network-proxy.ts";
import type { SandboxBackend, SandboxLaunch } from "./supervisor.ts";
import { createTerminalHandoff, TERMINAL_HANDOFF_PATH_VARIABLE, type TerminalHandoff } from "./terminal-handoff.ts";
import type { SandboxViolationStore } from "./violations.ts";

export interface MacosSandboxBackendOptions {
	/** Injectable only for preflight tests; production uses the running platform. */
	platform?: NodeJS.Platform;
	commandExists?: (command: string) => boolean;
	violationStore?: SandboxViolationStore;
	/**
	 * Injectable only so violation attribution can be tested off macOS; production
	 * spawns `sandbox-exec` directly. Without this the decision about what counts as a
	 * violation would be verifiable only on a macOS host.
	 */
	spawnChild?: typeof spawn;
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
 * containing each path is needed -- no ancestor walk. Each directory is resolved to
 * its real (symlink-free) path: Seatbelt canonicalizes the path it actually checks
 * against a `subpath` rule (confirmed empirically -- a rule built from an
 * unresolved symlinked path, e.g. Homebrew's own layout, silently never matches).
 */
function readOnlyDirectories(paths: readonly string[]): string[] {
	const directories = paths.map((path) => dirname(resolve(path)));
	const canonical = directories.map((directory) => {
		try {
			return realpathSync(directory);
		} catch {
			return directory;
		}
	});
	return [...new Set(canonical)];
}

/**
 * Canonicalize a channel socket path for a Seatbelt literal. Only the directory can be
 * resolved -- the socket file need not exist yet when the profile is written -- and the
 * same symlink rule as `readOnlyDirectories` applies: Seatbelt matches the canonical
 * path, so an unresolved one silently never matches.
 */
function canonicalSocketPath(path: string): string {
	const directory = dirname(resolve(path));
	try {
		return join(realpathSync(directory), basename(path));
	} catch {
		return join(directory, basename(path));
	}
}

/** Seatbelt refuses through the blocked call's own errno text, not a wrapper message. */
const DENIAL_EVIDENCE = /Operation not permitted|Permission denied|EPERM|EACCES/i;

function classifySandboxFailure(stderr: string): "filesystem" | "network" | "unknown" | undefined {
	// Confirmed empirically (2b.5 prototype): unlike Linux's bwrap, macOS Seatbelt
	// denials surface through the launched command's own generic "Operation not
	// permitted"/EPERM text for filesystem AND network refusals alike -- there is no
	// macOS-specific phrase equivalent to Linux's distinct "Network is unreachable".
	// Only sandbox-exec's own wrapper-level exec refusal (a sign our own profile
	// forgot to allow a binary, not a policy decision) is unambiguous from stderr
	// text. Anything else that still shows a refusal stays "unknown";
	// network-proxy.ts's own precise per-request recording is the reliable "network"
	// signal on this platform.
	if (/execvp\(\) of .* failed: Operation not permitted/i.test(stderr)) return "filesystem";
	if (DENIAL_EVIDENCE.test(stderr)) return "unknown";
	// No refusal in evidence. The coarseness above is about telling filesystem from
	// network, not about telling a denial from an ordinary failure -- a non-zero exit
	// on its own says nothing about the boundary, and reporting it as a violation
	// sends the reader looking for a refusal that never happened.
	return undefined;
}

/**
 * macOS's platform adapter. Seatbelt (`sandbox-exec`) allows reads broadly except
 * the invoking account's home directory, denies writes outside the workspace, and
 * denies network outside the sandbox proxy's exact loopback port -- narrower than
 * the wildcard `localhost:*` pattern some other sandboxes use. This mirrors Linux's
 * actual posture (`--ro-bind / /` plus a hidden `/home`) rather than the narrower
 * read-allowlist this design started with, which broke ordinary process startup.
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
	let handoff: TerminalHandoff | undefined;

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
			// Same reasoning as readOnlyDirectories: on macOS the workspace itself can
			// be reached through a symlink (e.g. os.tmpdir()'s /var -> /private/var),
			// and Seatbelt's subpath match is against the canonical path, not the one
			// the caller happened to spell. Resolve once, use everywhere below.
			const workspace = realpathSync(launch.policy.workspace);
			const stateDirectory = join(workspace, ".apex-code", "sandbox-state");
			mkdirSync(stateDirectory, { recursive: true });

			const violationCountBeforeLaunch = violationStore?.totalCount ?? 0;

			handoff = createTerminalHandoff(stateDirectory);
			proxy = await createSandboxNetworkProxy({
				tcpHost: "127.0.0.1",
				allowedHosts: launch.policy.allowedHosts,
				violationStore,
				// Undefined without a terminal, which leaves the proxy's own
				// deny-without-asking path in place for headless, print, JSON, and RPC.
				requestApproval: createHostApprover({ handoff }),
			});
			const proxyPort = proxy.port as number;

			// Seatbelt cannot remap a path, so the child connects to the channel socket at
			// its host path, and the profile allows outbound to exactly that one socket.
			const credentialChannelSocket = launch.credentialChannel
				? canonicalSocketPath(launch.credentialChannel.hostSocketPath)
				: undefined;

			const readOnlyDirs = readOnlyDirectories([process.execPath, launch.command, ...(launch.readOnlyPaths ?? [])]);
			const readOnlyFiles = (launch.readOnlyFiles ?? []).map((path) => {
				try {
					return realpathSync(path);
				} catch {
					return resolve(path);
				}
			});
			let userHome: string | undefined;
			try {
				userHome = realpathSync(homedir());
			} catch {
				userHome = homedir();
			}

			const profileLines = [
				"(version 1)",
				// bsd.sb's baseline is broader than Linux's opt-in bind-mount model --
				// a real gap this design accepts, documented in the spec's fourth
				// amendment -- but it is the only combination the 2b.5 prototype found
				// that lets a normal Unix child process (dyld, /bin/sh) actually start.
				'(import "bsd.sb")',
				"(allow process-exec*)",
				// Separate from process-exec* -- confirmed empirically: a shell that
				// forks a child shell (e.g. `sh -c 'a' && sh -c 'b'`) failed with
				// "fork: Operation not permitted" without this, even with exec allowed.
				"(allow process-fork)",
				// Matches Linux's actual posture (bwrap's `--ro-bind / /`): broad read,
				// narrow write. A read-only allowlist alone (this design's first cut)
				// breaks ordinary process startup -- confirmed empirically, getcwd()
				// itself needs to traverse the workspace's ancestor directories, which
				// no read rule scoped only to the workspace or runtime paths covers.
				"(allow file-read*)",
				'(deny file-read* (subpath (param "USER_HOME")))',
				...readOnlyDirs.map((_, index) => `(allow file-read* (subpath (param "RO_${index}")))`),
				...readOnlyFiles.map((_, index) => `(allow file-read* (subpath (param "RO_FILE_${index}")))`),
				'(allow file-read* (subpath (param "WORKSPACE")))',
				"(deny file-write*)",
				'(allow file-write* (subpath (param "WORKSPACE")))',
				"(deny network*)",
				'(allow network-outbound (remote ip (param "PROXY_ADDR")))',
				...(credentialChannelSocket
					? [`(allow network-outbound (remote unix-socket (literal "${credentialChannelSocket}")))`]
					: []),
			];
			const profilePath = join(stateDirectory, "profile.sb");
			writeFileSync(profilePath, profileLines.join("\n"));

			const params: string[] = ["-D", `USER_HOME=${userHome}`];
			readOnlyDirs.forEach((dir, index) => {
				params.push("-D", `RO_${index}=${dir}`);
			});
			readOnlyFiles.forEach((file, index) => {
				params.push("-D", `RO_FILE_${index}=${file}`);
			});
			params.push("-D", `WORKSPACE=${workspace}`);
			params.push("-D", `PROXY_ADDR=localhost:${proxyPort}`);

			const spawnSandboxExec = options?.spawnChild ?? spawn;
			const child = spawnSandboxExec(
				"sandbox-exec",
				["-f", profilePath, ...params, "--", launch.command, ...launch.args],
				{
					cwd: workspace,
					env: {
						...launch.environment,
						HOME: launch.environment?.HOME ?? stateDirectory,
						TMPDIR: launch.environment?.TMPDIR ?? stateDirectory,
						HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
						HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
						[TERMINAL_HANDOFF_PATH_VARIABLE]: stateDirectory,
					},
					stdio: ["inherit", "inherit", "pipe"],
				},
			);
			let stderr = "";
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
				process.stderr.write(chunk);
			});
			const exitCode = await waitForExit(child);
			await proxy?.close();
			const proxyAlreadyRecordedAViolation = (violationStore?.totalCount ?? 0) > violationCountBeforeLaunch;
			const kind = exitCode !== 0 && !proxyAlreadyRecordedAViolation ? classifySandboxFailure(stderr) : undefined;
			if (kind) {
				violationStore?.add({
					kind,
					command: [launch.command, ...launch.args].join(" "),
					detail: stderr.trim(),
					timestamp: new Date(),
				});
			}
			return exitCode;
		},
		async close() {
			handoff?.stop();
			await proxy?.close();
		},
	};
}
