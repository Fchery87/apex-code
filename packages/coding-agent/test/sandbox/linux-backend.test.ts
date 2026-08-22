import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";
import { createSandboxSupervisor } from "../../src/core/sandbox/supervisor.ts";
import { SandboxViolationStore } from "../../src/core/sandbox/violations.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-sandbox-linux-"));
	temporaryDirectories.push(directory);
	return directory;
}

function canEnforceLinuxSandbox(): boolean {
	return process.platform === "linux" && createLinuxSandboxBackend().status.kind === "enforced";
}

describe.skipIf(!canEnforceLinuxSandbox())("Linux sandbox backend", () => {
	it("permits a child and grandchild to write only in the workspace", async () => {
		const cwd = workspace();
		const outside = join(dirname(cwd), `outside-${Date.now()}.txt`);
		const violations = new SandboxViolationStore();
		const backend = createLinuxSandboxBackend({ violationStore: violations });
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });
		const script = `sh -c 'printf allowed > ${join(cwd, "allowed.txt")}' && sh -c 'printf blocked > ${outside}'`;

		await expect(supervisor.launch({ command: "/bin/sh", args: ["-c", script] })).resolves.not.toBe(0);
		expect(readFileSync(join(cwd, "allowed.txt"), "utf8")).toBe("allowed");
		expect(existsSync(outside)).toBe(false);
		expect(violations.list()).toMatchObject([{ kind: "filesystem" }]);
		await supervisor.close();
	});

	it("projects a host credential file read-only without exposing sibling files", async () => {
		const cwd = workspace();
		const hostDirectory = workspace();
		const authPath = join(hostDirectory, "auth.json");
		const siblingPath = join(hostDirectory, "settings.json");
		mkdirSync(hostDirectory, { recursive: true });
		writeFileSync(authPath, "host-secret", { mode: 0o600 });
		writeFileSync(siblingPath, "host-settings", { mode: 0o600 });
		const backend = createLinuxSandboxBackend();
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			const script = `test "$(cat ${authPath})" = host-secret && test ! -e ${siblingPath}`;
			await expect(
				supervisor.launch({ command: "/bin/sh", args: ["-c", script], readOnlyFiles: [authPath] }),
			).resolves.toBe(0);
			await expect(
				supervisor.launch({
					command: "/bin/sh",
					args: ["-c", `printf changed > ${authPath}`],
					readOnlyFiles: [authPath],
				}),
			).resolves.not.toBe(0);
			expect(readFileSync(authPath, "utf8")).toBe("host-secret");
		} finally {
			await supervisor.close();
		}
	});

	it("projects a host tool executable read-only at the child's managed tools path", async () => {
		const cwd = workspace();
		const hostToolsDirectory = workspace();
		// The host name differs from the child name on purpose: Debian ships fd as fdfind.
		const source = join(hostToolsDirectory, "fdfind");
		writeFileSync(source, "#!/bin/sh\necho projected-tool\n", { mode: 0o755 });
		const destination = join(cwd, ".apex-code", "sandbox-agent", "bin", "fd");
		mkdirSync(dirname(destination), { recursive: true });
		const backend = createLinuxSandboxBackend();
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			await expect(
				supervisor.launch({
					command: "/bin/sh",
					args: ["-c", `test "$(${destination})" = projected-tool`],
					readOnlyBinaries: [{ source, destination }],
				}),
			).resolves.toBe(0);
			await expect(
				supervisor.launch({
					command: "/bin/sh",
					args: ["-c", `printf tampered > ${destination}`],
					readOnlyBinaries: [{ source, destination }],
				}),
			).resolves.not.toBe(0);
			expect(readFileSync(source, "utf8")).toContain("projected-tool");
		} finally {
			await supervisor.close();
		}
	});

	it("does not report a violation when the child simply failed on its own", async () => {
		// An invalid API key, a failing test command, a script exiting 1: the boundary
		// refused nothing, so blaming it misdirects whoever reads the output.
		const cwd = workspace();
		const violations = new SandboxViolationStore();
		const backend = createLinuxSandboxBackend({ violationStore: violations });
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			await expect(
				supervisor.launch({
					command: "/bin/sh",
					args: ["-c", "echo 'ordinary application failure' >&2; exit 3"],
				}),
			).resolves.toBe(3);
			expect(violations.list()).toEqual([]);
		} finally {
			await supervisor.close();
		}
	});

	it("launches from a workspace too deep for a socket path inside it", async () => {
		// AF_UNIX caps sun_path at 108 bytes. Keeping the proxy socket under the workspace
		// spent that budget on the user's directory layout, so a deep-but-ordinary project
		// failed to start at all with "listen EINVAL".
		const root = workspace();
		const deep = join(root, "a".repeat(60), "b".repeat(60));
		mkdirSync(deep, { recursive: true });
		expect(join(deep, ".apex-code", "sandbox-state", "proxy.sock").length).toBeGreaterThan(108);

		const backend = createLinuxSandboxBackend();
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: deep, allowedHosts: [] } });

		try {
			await expect(supervisor.launch({ command: "/bin/sh", args: ["-c", "true"] })).resolves.toBe(0);
		} finally {
			await supervisor.close();
		}
	});

	it("does not expose the invoking account home outside the workspace mount", async () => {
		const cwd = workspace();
		const backend = createLinuxSandboxBackend();
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			await expect(
				supervisor.launch({ command: "/bin/sh", args: ["-c", `test ! -e ${join(homedir(), ".bashrc")}`] }),
			).resolves.toBe(0);
		} finally {
			await supervisor.close();
		}
	});

	it('launches inside a workspace whose package.json declares "type": "module"', async () => {
		const cwd = workspace();
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ type: "module" }));
		const backend = createLinuxSandboxBackend();
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			await expect(supervisor.launch({ command: "/bin/sh", args: ["-c", "true"] })).resolves.toBe(0);
		} finally {
			await supervisor.close();
		}
	});

	it("blocks and records an attempted connection to a host absent from the allowlist", async () => {
		const cwd = workspace();
		const violations = new SandboxViolationStore();
		const backend = createLinuxSandboxBackend({ violationStore: violations });
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			await expect(
				supervisor.launch({
					command: "/bin/bash",
					args: ["-c", "echo > /dev/tcp/198.51.100.1/443"],
				}),
			).resolves.not.toBe(0);
			expect(violations.list()).toMatchObject([{ kind: "network" }]);
		} finally {
			await supervisor.close();
		}
	});
});

describe("Linux sandbox preflight", () => {
	it("is unavailable rather than pretending to enforce on a non-Linux platform", () => {
		const backend = createLinuxSandboxBackend({ platform: "darwin", commandExists: () => true });
		expect(backend.status).toEqual({ kind: "unavailable", reason: "OS sandbox is supported on Linux only." });
	});

	it("is unavailable when Bubblewrap cannot be started", () => {
		const backend = createLinuxSandboxBackend({ platform: "linux", commandExists: () => false });
		expect(backend.status).toEqual({
			kind: "unavailable",
			reason: "Bubblewrap (bwrap) is required for OS sandboxing.",
		});
	});
});

function openFileDescriptorTargets(): string[] {
	const fdDirectory = "/proc/self/fd";
	return readdirSync(fdDirectory).flatMap((entry) => {
		try {
			return [readlinkSync(join(fdDirectory, entry))];
		} catch {
			return [];
		}
	});
}

describe.skipIf(process.platform !== "linux")("Linux sandbox crash cleanup", () => {
	it("closes an open read-only credential descriptor even when the sandboxed spawn itself fails", async () => {
		const cwd = workspace();
		const hostDirectory = workspace();
		const authPath = join(hostDirectory, "auth.json");
		writeFileSync(authPath, "host-secret", { mode: 0o600 });

		const backend = createLinuxSandboxBackend({
			platform: "linux",
			commandExists: () => true,
			spawnChild: (() => {
				const fake = new EventEmitter() as unknown as ChildProcess;
				queueMicrotask(() => fake.emit("error", new Error("bwrap vanished mid-launch")));
				return fake;
			}) as unknown as typeof spawn,
		});
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		await expect(
			supervisor.launch({ command: "/bin/sh", args: ["-c", "true"], readOnlyFiles: [authPath] }),
		).rejects.toThrow("bwrap vanished mid-launch");
		await supervisor.close();

		const leaked = openFileDescriptorTargets().some((target) => target.includes(authPath));
		expect(leaked).toBe(false);
	});
});

describe.skipIf(!canEnforceLinuxSandboxForChannel())("Linux credential channel projection", () => {
	it("binds the channel socket into the child and names it in the environment", async () => {
		const cwd = workspace();
		const hostDirectory = mkdtempSync(join(tmpdir(), "apex-cred-bind-"));
		temporaryDirectories.push(hostDirectory);
		const hostSocketPath = join(hostDirectory, "channel.sock");
		// The backend binds whatever path it is given; the supervisor's proxy is what
		// listens on it. A real listening socket proves both the mount and the
		// child-visible path, and stands in for the proxy exactly the way it will
		// exist in production: created by the supervisor before launch.
		const listener = net.createServer(() => {});
		await new Promise<void>((resolve) => listener.listen(hostSocketPath, resolve));

		const backend = createLinuxSandboxBackend();
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			await expect(
				supervisor.launch({
					command: "/bin/sh",
					args: ["-c", 'test -S "$APEX_CREDENTIAL_PROXY_PATH"'],
					// The launch builder (cli-launch.ts) advertises the channel to the
					// child; the backend's job under test is the bind that makes that
					// path a real socket inside the sandbox.
					environment: { APEX_CREDENTIAL_PROXY_PATH: "/home/channel.sock" },
					credentialChannel: { hostSocketPath, childSocketPath: "/home/channel.sock" },
				}),
			).resolves.toBe(0);
		} finally {
			await supervisor.close();
			await new Promise<void>((resolve) => listener.close(() => resolve()));
		}
	});

	it("adds no channel environment when the supervisor opened no channel", async () => {
		const cwd = workspace();
		const backend = createLinuxSandboxBackend();
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			await expect(
				supervisor.launch({
					command: "/bin/sh",
					args: ["-c", 'test -z "$APEX_CREDENTIAL_PROXY_PATH"'],
				}),
			).resolves.toBe(0);
		} finally {
			await supervisor.close();
		}
	});
});

function canEnforceLinuxSandboxForChannel(): boolean {
	return process.platform === "linux" && createLinuxSandboxBackend().status.kind === "enforced";
}
