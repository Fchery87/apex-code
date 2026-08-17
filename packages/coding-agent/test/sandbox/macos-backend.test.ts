import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

	it("projects a host credential file read-only without exposing sibling files", async () => {
		const cwd = workspace();
		const hostDirectory = workspace();
		const authPath = join(hostDirectory, "auth.json");
		const siblingPath = join(hostDirectory, "settings.json");
		mkdirSync(hostDirectory, { recursive: true });
		writeFileSync(authPath, "host-secret", { mode: 0o600 });
		writeFileSync(siblingPath, "host-settings", { mode: 0o600 });
		const backend = createMacosSandboxBackend();
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
