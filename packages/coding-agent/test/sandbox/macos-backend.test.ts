import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMacosSandboxBackend } from "../../src/core/sandbox/macos-backend.ts";
import { createSandboxSupervisor } from "../../src/core/sandbox/supervisor.ts";
import { SandboxViolationStore } from "../../src/core/sandbox/violations.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-sandbox-macos-"));
	temporaryDirectories.push(directory);
	return directory;
}

/**
 * A temp directory under the real invoking account's home directory. Seatbelt's
 * per-file read allowance (RO_FILE_n) only matters where the surrounding
 * `(deny file-read* (subpath USER_HOME))` rule would otherwise apply -- outside
 * USER_HOME, the broad base `(allow file-read*)` rule already permits reading
 * everything, siblings included, regardless of any RO_FILE allowlist. Real
 * credentials live under `~/.apex-code/agent/`, inside USER_HOME, so a fixture
 * under the system temp directory (outside USER_HOME) does not exercise the
 * same code path production actually relies on for sibling-hiding.
 */
function homeDirectory(): string {
	const directory = mkdtempSync(join(homedir(), ".apex-sandbox-macos-test-"));
	temporaryDirectories.push(directory);
	// Matches macos-backend.ts's own realpathSync(homedir()) for USER_HOME --
	// belt-and-suspenders in case the account home is itself reached through a
	// symlink on some runner configuration.
	return realpathSync(directory);
}

function canEnforceMacosSandbox(): boolean {
	return process.platform === "darwin" && createMacosSandboxBackend().status.kind === "enforced";
}

describe.skipIf(!canEnforceMacosSandbox())("macOS sandbox backend", () => {
	it("permits a child and grandchild to write only in the workspace", async () => {
		const cwd = workspace();
		const outside = join(dirname(cwd), `outside-${Date.now()}.txt`);
		const violations = new SandboxViolationStore();
		const backend = createMacosSandboxBackend({ violationStore: violations });
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });
		const script = `sh -c 'printf allowed > ${join(cwd, "allowed.txt")}' && sh -c 'printf blocked > ${outside}'`;

		await expect(supervisor.launch({ command: "/bin/sh", args: ["-c", script] })).resolves.not.toBe(0);
		expect(readFileSync(join(cwd, "allowed.txt"), "utf8")).toBe("allowed");
		expect(existsSync(outside)).toBe(false);
		// macOS's own denial text doesn't reliably distinguish filesystem from network
		// refusals (see macos-backend.ts's classifySandboxFailure), so this asserts
		// "unknown", not "filesystem" -- the write being blocked is what matters here.
		expect(violations.list()).toMatchObject([{ kind: "unknown" }]);
		await supervisor.close();
	});

	it("does not expose the invoking account home outside the workspace mount", async () => {
		const cwd = workspace();
		const backend = createMacosSandboxBackend();
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			await expect(
				supervisor.launch({ command: "/bin/sh", args: ["-c", `test ! -e ${join(homedir(), ".zshrc")}`] }),
			).resolves.toBe(0);
		} finally {
			await supervisor.close();
		}
	});

	// Split into independent assertions (rather than one compound script) so a
	// real CI failure identifies which specific guarantee broke, not just that
	// something in the combined script returned nonzero.
	//
	// Sibling-hiding (Linux's equivalent test also asserts a sibling file next
	// to the projected credential stays invisible, via bwrap's tmpfs-shadow
	// mount) is deliberately not asserted here. macOS's Seatbelt backend has no
	// mount-shadowing primitive -- readOnlyFiles is a `subpath` allow-rule
	// layered over the real filesystem, not an isolated view of one directory
	// entry -- and ADR 0015 does not require directory-level sibling isolation,
	// only that the child is read-only and cannot write host credentials. This
	// is a real, open platform-capability gap (ADR 0005 already documents
	// macOS's network guarantee as "categorically weaker" than Linux's for the
	// same kind of reason), not something asserted and then quietly dropped.
	it("reads a host-owned credential file through the read-only projection", async () => {
		const cwd = workspace();
		const hostDirectory = homeDirectory();
		const authPath = join(hostDirectory, "auth.json");
		mkdirSync(hostDirectory, { recursive: true });
		writeFileSync(authPath, "host-secret", { mode: 0o600 });
		const backend = createMacosSandboxBackend();
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			await expect(
				supervisor.launch({
					command: "/bin/sh",
					args: ["-c", `cat ${authPath} | grep -q host-secret`],
					readOnlyFiles: [authPath],
				}),
			).resolves.toBe(0);
		} finally {
			await supervisor.close();
		}
	});

	it("rejects a write attempt to a projected host credential file", async () => {
		const cwd = workspace();
		const hostDirectory = homeDirectory();
		const authPath = join(hostDirectory, "auth.json");
		mkdirSync(hostDirectory, { recursive: true });
		writeFileSync(authPath, "host-secret", { mode: 0o600 });
		const backend = createMacosSandboxBackend();
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
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

	it("blocks a direct connection attempt to a host outside the sandbox proxy and records a violation", async () => {
		// This bypasses network-proxy.ts entirely (a direct net.connect, no
		// HTTP_PROXY involved), so it exercises Seatbelt's own `deny network*`
		// directly. classifySandboxFailure() deliberately reports "unknown" here,
		// not "network" -- macOS's own denial text does not reliably distinguish
		// filesystem from network refusals the way Linux's bwrap stderr does (see
		// the 2b.5 prototype and the comment on classifySandboxFailure).
		const cwd = workspace();
		const violations = new SandboxViolationStore();
		const backend = createMacosSandboxBackend({ violationStore: violations });
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			await expect(
				supervisor.launch({
					command: process.execPath,
					args: ["-e", "require('node:net').connect(443,'198.51.100.1').on('error',()=>process.exit(1))"],
				}),
			).resolves.not.toBe(0);
			expect(violations.list()).toHaveLength(1);
		} finally {
			await supervisor.close();
		}
	});
});

describe("macOS sandbox preflight", () => {
	it("is unavailable rather than pretending to enforce on a non-macOS platform", () => {
		const backend = createMacosSandboxBackend({ platform: "linux", commandExists: () => true });
		expect(backend.status).toEqual({ kind: "unavailable", reason: "OS sandbox is supported on macOS only." });
	});

	it("is unavailable when sandbox-exec cannot be started", () => {
		const backend = createMacosSandboxBackend({ platform: "darwin", commandExists: () => false });
		expect(backend.status).toEqual({
			kind: "unavailable",
			reason: "sandbox-exec (Seatbelt) is required for OS sandboxing.",
		});
	});
});

// These drive the real backend with an injected child, so the decision about what
// counts as a violation is covered on any platform rather than only on macOS CI --
// which matters because the machine that wrote this has no macOS host.
describe("macOS violation attribution", () => {
	function launchWith(exitCode: number, stderr: string): Promise<SandboxViolationStore> {
		const violations = new SandboxViolationStore();
		const backend = createMacosSandboxBackend({
			platform: "darwin",
			commandExists: () => true,
			violationStore: violations,
			spawnChild: (() => {
				const fake = new EventEmitter() as unknown as ChildProcess;
				const stderrStream = new EventEmitter() as unknown as NonNullable<ChildProcess["stderr"]>;
				(stderrStream as unknown as { setEncoding: (encoding: string) => void }).setEncoding = () => {};
				(fake as { stderr: unknown }).stderr = stderrStream;
				setImmediate(() => {
					if (stderr) stderrStream.emit("data", stderr);
					fake.emit("exit", exitCode);
				});
				return fake;
			}) as unknown as typeof spawn,
		});
		const cwd = workspace();
		return backend
			.launch({ command: "/bin/sh", args: ["-c", "true"], policy: { workspace: cwd, allowedHosts: [] } })
			.then(async () => {
				await backend.close();
				return violations;
			});
	}

	it("stays silent when the child failed for its own reasons", async () => {
		const violations = await launchWith(3, "error: invalid API key\n");
		expect(violations.list()).toEqual([]);
	});

	it("records a Seatbelt denial, which surfaces as a generic EPERM message", async () => {
		const violations = await launchWith(1, "sh: /outside/file.txt: Operation not permitted\n");
		expect(violations.list()).toMatchObject([{ kind: "unknown" }]);
	});

	it("still distinguishes the profile's own exec refusal", async () => {
		const violations = await launchWith(1, "sandbox-exec: execvp() of '/bin/sh' failed: Operation not permitted\n");
		expect(violations.list()).toMatchObject([{ kind: "filesystem" }]);
	});

	it("stays silent on a successful run regardless of stderr chatter", async () => {
		const violations = await launchWith(0, "warning: something noisy\n");
		expect(violations.list()).toEqual([]);
	});
});
