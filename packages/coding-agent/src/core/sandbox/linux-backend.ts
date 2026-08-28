import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createCredentialReleaser, createHostApprover } from "./host-approval.ts";
import { createSandboxNetworkProxy, type SandboxNetworkProxy } from "./network-proxy.ts";
import {
	fillHostGitCredential,
	GIT_CREDENTIAL_SOCKET_VARIABLE,
	resolveGitCredentialChannelPaths,
	writeGitCredentialHelper,
} from "./rpc/git-credential-helper.ts";
import { createGitCredentialProxy, type GitCredentialProxy } from "./rpc/git-credential-proxy.ts";
import type { SandboxBackend, SandboxLaunch } from "./supervisor.ts";
import { createTerminalHandoff, TERMINAL_HANDOFF_PATH_VARIABLE, type TerminalHandoff } from "./terminal-handoff.ts";
import { publishTerminalSize, TERMINAL_SIZE_PATH_VARIABLE } from "./terminal-size.ts";
import type { SandboxViolationStore } from "./violations.ts";

/** AF_UNIX `sun_path` is 108 bytes on Linux, including the terminating NUL. */
const SUN_PATH_LIMIT = 108;

export interface LinuxSandboxBackendOptions {
	/** Injectable only for preflight tests; production uses the running platform. */
	platform?: NodeJS.Platform;
	commandExists?: (command: string) => boolean;
	violationStore?: SandboxViolationStore;
	/** Injectable only to prove crash cleanup in tests; production spawns `bwrap` directly. */
	spawnChild?: typeof spawn;
	/**
	 * Injectable only for tests, which have no terminal and would otherwise be unable to
	 * exercise a released credential at all. Production builds the releaser from the
	 * terminal handoff, and its absence there is what makes a headless session refuse.
	 */
	requestGitCredentialRelease?: (host: string) => Promise<boolean>;
	/** Injectable only for tests; production resolves against the real host store. */
	fillGitCredential?: typeof fillHostGitCredential;
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

function ancestorDirectoryArguments(directory: string): string[] {
	const ancestors: string[] = [];
	let current = directory;
	while (current !== "/" && current !== "/home") {
		ancestors.push(current);
		current = dirname(current);
	}
	return ancestors.reverse().flatMap((ancestor) => ["--dir", ancestor]);
}

function readOnlyMountArguments(path: string): string[] {
	const directory = dirname(resolve(path));
	return [...ancestorDirectoryArguments(directory), "--ro-bind", directory, directory];
}

/**
 * Project every read-only file, grouped by the directory each one lives in.
 *
 * A file needs a `--tmpfs` over its parent to have somewhere to be mounted, and that
 * tmpfs replaces whatever the parent held. Emitting one per file meant two files sharing
 * a directory produced two `--tmpfs` on the same path, and the second silently masked the
 * first -- the child saw one file and got ENOENT for the other. Grouping keeps a single
 * tmpfs per directory carrying every file bound into it.
 *
 * Descriptor numbers stay tied to each path's index in the original list, because the
 * caller opens them in that order and passes them to `spawn` as `stdio` entries 3 onward.
 */
function readOnlyFileMountArguments(paths: readonly string[], firstDescriptor = 3): string[] {
	const byDirectory = new Map<string, { target: string; descriptor: number }[]>();
	paths.forEach((path, index) => {
		const target = resolve(path);
		const directory = dirname(target);
		const group = byDirectory.get(directory);
		const entry = { target, descriptor: firstDescriptor + index };
		if (group) group.push(entry);
		else byDirectory.set(directory, [entry]);
	});
	return [...byDirectory].flatMap(([directory, files]) => [
		...ancestorDirectoryArguments(directory),
		"--tmpfs",
		directory,
		...files.flatMap(({ target, descriptor }) => ["--perms", "0400", "--file", String(descriptor), target]),
	]);
}

/**
 * Where the supervisor's proxy socket lives on each side of the boundary.
 *
 * AF_UNIX caps `sun_path` at 108 bytes, so the socket cannot live under the workspace:
 * a deep-but-ordinary project directory exhausts that budget and the sandbox fails to
 * start at all with `listen EINVAL`. The host side therefore gets a short, unique path
 * under the system temp directory, and it is bind-mounted into the child.
 *
 * The child-side path has to sit under `/home`. That is the one writable mount at the
 * point the mountpoint is created — the sandbox root is a read-only bind, so bwrap
 * cannot create a mountpoint at `/run`, `/tmp`, or anywhere else on it.
 */
export function resolveProxySocketPaths(temporaryDirectory: string = tmpdir()): {
	hostSocketPath: string;
	childSocketPath: string;
} {
	const name = `apex-${process.pid}-${randomBytes(4).toString("hex")}.sock`;
	// An unusually long TMPDIR would reintroduce the very limit this avoids.
	const base = join(temporaryDirectory, name).length + 1 > SUN_PATH_LIMIT ? "/tmp" : temporaryDirectory;
	return { hostSocketPath: join(base, name), childSocketPath: `/home/${name}` };
}

/**
 * Classify an unsuccessful child from what its stderr actually evidences, or return
 * undefined when nothing suggests the boundary refused anything.
 *
 * A non-zero exit is not a violation. An invalid API key, a failing test command, or a
 * script exiting 1 are the child's own business, and recording them as sandbox
 * violations blames the boundary for failures it had no part in — which is worse than
 * silence, because it sends whoever reads the output looking for a refusal that never
 * happened. Only Linux's own refusal wording earns a violation here; the proxy records
 * network refusals itself, before this fallback is consulted.
 */
function classifySandboxFailure(stderr: string): "filesystem" | "network" | undefined {
	if (/Read-only file system|Permission denied|Operation not permitted/i.test(stderr)) return "filesystem";
	if (/Network is unreachable|ENETUNREACH|EHOSTUNREACH/i.test(stderr)) return "network";
	return undefined;
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
	let proxy: SandboxNetworkProxy | undefined;
	let handoff: TerminalHandoff | undefined;
	let gitCredentialProxy: GitCredentialProxy | undefined;
	let gitCredentialDirectory: string | undefined;

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

			const violationCountBeforeLaunch = violationStore?.totalCount ?? 0;

			const { hostSocketPath, childSocketPath } = resolveProxySocketPaths();
			handoff = createTerminalHandoff(stateDirectory);
			const gitCredentialPaths = resolveGitCredentialChannelPaths();
			gitCredentialDirectory = gitCredentialPaths.hostSocketDirectory;
			proxy = await createSandboxNetworkProxy({
				socketPath: hostSocketPath,
				allowedHosts: launch.policy.allowedHosts,
				violationStore,
				// Undefined without a terminal, which leaves the proxy's own
				// deny-without-asking path in place for headless, print, JSON, and RPC.
				requestApproval: createHostApprover({ handoff }),
			});
			// After the network proxy, because reachability is its answer to give: the
			// credential channel must never hand out a token for a host this session
			// cannot even open a connection to.
			gitCredentialProxy = await createGitCredentialProxy({
				socketPath: gitCredentialPaths.hostSocketPath,
				isHostAllowed: (host) => proxy?.isHostReachable(host) ?? false,
				requestRelease: options?.requestGitCredentialRelease ?? createCredentialReleaser({ handoff }),
				// The supervisor's own environment, deliberately: this runs outside the
				// boundary and must resolve against the real host home, which is exactly
				// what the child cannot see.
				fillCredential: (request) =>
					(options?.fillGitCredential ?? fillHostGitCredential)(request, { environment: process.env }),
				violationStore,
			});
			writeGitCredentialHelper(stateDirectory);

			// .cjs forces CommonJS regardless of the target workspace's package.json "type"
			// field -- a plain .js here would be parsed as ESM under "type": "module" and
			// crash on `require`, since Node resolves module type from the nearest package.json.
			const relayScriptPath = join(stateDirectory, "relay.cjs");
			writeFileSync(
				relayScriptPath,
				`
const net = require("node:net");
const child_process = require("node:child_process");

const socketPath = process.env.APEX_UDS_PATH;
const server = net.createServer((c) => {
	const client = net.connect(socketPath);
	c.pipe(client).pipe(c);
	c.on("error", () => {});
	client.on("error", () => {});
});

server.listen(0, "127.0.0.1", () => {
	const port = server.address().port;
	const env = Object.assign({}, process.env, {
		HTTP_PROXY: \`http://127.0.0.1:\${port}\`,
		HTTPS_PROXY: \`http://127.0.0.1:\${port}\`
	});
	const args = process.argv.slice(2);
	const child = child_process.spawn(args[0], args.slice(1), {
		stdio: "inherit",
		env: env,
	});
	child.on("exit", (code, signal) => {
		process.exit(code ?? (signal ? 128 : 1));
	});
});
server.on("error", (err) => {
	console.error("Relay error:", err);
	process.exit(1);
});
`.trim(),
			);

			const readOnlyMounts = [process.execPath, launch.command, ...(launch.readOnlyPaths ?? [])].flatMap((path) =>
				readOnlyMountArguments(path),
			);
			const readOnlyFileMounts = readOnlyFileMountArguments(launch.readOnlyFiles ?? []);
			const readOnlyFileDescriptors = (launch.readOnlyFiles ?? []).map((path) => openSync(path, "r"));
			// The descriptors above are opened before the child spawns and must be closed
			// on every exit path -- including a spawn/wait rejection -- or a crashed launch
			// leaks an open handle onto a host-owned credential file for the process's life.
			// The workspace is bind-mounted read-write into the sandbox, so a file
			// here is visible at the same absolute path on both sides of it.
			const terminalSizePath = join(stateDirectory, "terminal-size");
			const stopPublishingTerminalSize = publishTerminalSize(terminalSizePath);
			try {
				const spawnBwrap = options?.spawnChild ?? spawn;
				const child = spawnBwrap(
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
						"--tmpfs",
						"/home",
						// Immediately after the /home tmpfs: that is the only writable mount at
						// this point, so it is the only place bwrap can create the mountpoint.
						"--bind",
						hostSocketPath,
						childSocketPath,
						// The credential channel socket: same writable-under-/home constraint
						// and same position as the network socket above. Its child-side path
						// is what `APEX_CREDENTIAL_PROXY_PATH` names in the launch environment.
						...(launch.credentialChannel
							? ["--bind", launch.credentialChannel.hostSocketPath, launch.credentialChannel.childSocketPath]
							: []),
						// Same writable-under-/home constraint and same position as the two
						// sockets above.
						"--bind",
						gitCredentialPaths.hostSocketPath,
						gitCredentialPaths.childSocketPath,
						...readOnlyMounts,
						...readOnlyFileMounts,
						"--bind",
						launch.policy.workspace,
						launch.policy.workspace,
						// After the workspace bind: these destinations sit inside it, and an
						// earlier mount would be masked when the workspace is bound over them.
						...(launch.readOnlyBinaries ?? []).flatMap(({ source, destination }) => [
							"--ro-bind",
							source,
							destination,
						]),
						"--dev",
						"/dev",
						"--proc",
						"/proc",
						"--chdir",
						launch.policy.workspace,
						"--setenv",
						"HOME",
						launch.environment?.HOME ?? stateDirectory,
						"--setenv",
						"TMPDIR",
						launch.environment?.TMPDIR ?? stateDirectory,
						"--setenv",
						"APEX_UDS_PATH",
						childSocketPath,
						"--setenv",
						TERMINAL_SIZE_PATH_VARIABLE,
						terminalSizePath,
						"--setenv",
						TERMINAL_HANDOFF_PATH_VARIABLE,
						stateDirectory,
						"--setenv",
						GIT_CREDENTIAL_SOCKET_VARIABLE,
						gitCredentialPaths.childSocketPath,
						"--",
						process.execPath,
						relayScriptPath,
						launch.command,
						...launch.args,
					],
					{ env: launch.environment, stdio: ["inherit", "inherit", "pipe", ...readOnlyFileDescriptors] },
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
			} finally {
				stopPublishingTerminalSize();
				for (const descriptor of readOnlyFileDescriptors) closeSync(descriptor);
				// The socket now lives outside the workspace, so nothing else will ever clean
				// it up; leaving it would litter the temp directory once per launch.
				rmSync(hostSocketPath, { force: true });
			}
		},
		async close() {
			handoff?.stop();
			await gitCredentialProxy?.close();
			if (gitCredentialDirectory) rmSync(gitCredentialDirectory, { force: true, recursive: true });
			await proxy?.close();
		},
	};
}
