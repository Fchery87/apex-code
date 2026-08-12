import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

	it("blocks an attempted connection to a host that is absent from the allowlist", async () => {
		const cwd = workspace();
		const backend = createLinuxSandboxBackend();
		const supervisor = createSandboxSupervisor({ backend, policy: { workspace: cwd, allowedHosts: [] } });

		try {
			await expect(
				supervisor.launch({
					command: "/bin/bash",
					args: ["-c", "echo > /dev/tcp/127.0.0.1/9"],
				}),
			).resolves.not.toBe(0);
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
