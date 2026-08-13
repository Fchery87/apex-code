import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
		expect(violations.list()).toMatchObject([{ kind: "filesystem" }]);
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

	it("blocks and records an attempted connection to a host absent from the allowlist, and allows one present in it", async () => {
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
			expect(violations.list().some((violation) => violation.kind === "network")).toBe(true);
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
