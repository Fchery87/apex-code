import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSandboxNetworkProxy, type SandboxNetworkProxy } from "./network-proxy.ts";
import type { SandboxBackend, SandboxLaunch } from "./supervisor.ts";
import type { SandboxViolationStore } from "./violations.ts";

export interface LinuxSandboxBackendOptions {
	/** Injectable only for preflight tests; production uses the running platform. */
	platform?: NodeJS.Platform;
	commandExists?: (command: string) => boolean;
	violationStore?: SandboxViolationStore;
	/** Injectable only to prove crash cleanup in tests; production spawns `bwrap` directly. */
	spawnChild?: typeof spawn;
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

function readOnlyMountArguments(path: string, kind: "directory" | "file" = "directory", descriptor = 3): string[] {
	const target = resolve(path);
	const directory = dirname(target);
	const ancestors: string[] = [];
	let current = directory;
	while (current !== "/" && current !== "/home") {
		ancestors.push(current);
		current = dirname(current);
	}
	const parentArguments = ancestors.reverse().flatMap((ancestor) => ["--dir", ancestor]);
	return kind === "file"
		? [...parentArguments, "--tmpfs", directory, "--perms", "0400", "--file", String(descriptor), target]
		: [...parentArguments, "--ro-bind", directory, directory];
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
	let proxy: SandboxNetworkProxy | undefined;

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

			const socketPath = join(stateDirectory, "proxy.sock");
			proxy = await createSandboxNetworkProxy({
				socketPath,
				allowedHosts: launch.policy.allowedHosts,
				violationStore,
			});

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
			const readOnlyFileMounts = (launch.readOnlyFiles ?? []).flatMap((path, index) =>
				readOnlyMountArguments(path, "file", index + 3),
			);
			const readOnlyFileDescriptors = (launch.readOnlyFiles ?? []).map((path) => openSync(path, "r"));
			// The descriptors above are opened before the child spawns and must be closed
			// on every exit path -- including a spawn/wait rejection -- or a crashed launch
			// leaks an open handle onto a host-owned credential file for the process's life.
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
						socketPath,
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
			} finally {
				for (const descriptor of readOnlyFileDescriptors) closeSync(descriptor);
			}
		},
		async close() {
			await proxy?.close();
		},
	};
}
