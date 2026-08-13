import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchSandboxedCli } from "../../src/core/sandbox/cli-supervisor.ts";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";
import { createMacosSandboxBackend } from "../../src/core/sandbox/macos-backend.ts";
import type { SandboxBackend, SandboxLaunch } from "../../src/core/sandbox/supervisor.ts";
import type { SandboxViolationStore } from "../../src/core/sandbox/violations.ts";

function canEnforceLinuxSandbox(): boolean {
	return process.platform === "linux" && createLinuxSandboxBackend().status.kind === "enforced";
}

function canEnforceMacosSandbox(): boolean {
	return process.platform === "darwin" && createMacosSandboxBackend().status.kind === "enforced";
}

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-sandbox-supervisor-"));
	directories.push(directory);
	return directory;
}

function backend(
	status: SandboxBackend["status"],
	exitCode = 0,
): SandboxBackend & { launches: SandboxLaunch[]; closed: boolean } {
	const launches: SandboxLaunch[] = [];
	let closed = false;
	return {
		status,
		launches,
		get closed() {
			return closed;
		},
		async launch(launch) {
			launches.push(launch);
			return exitCode;
		},
		async close() {
			closed = true;
		},
	};
}

describe("CLI sandbox supervisor", () => {
	it("runs only the normal child entry beneath an enforcing backend and closes it", async () => {
		const enforcing = backend({ kind: "enforced" }, 23);
		const code = await launchSandboxedCli({
			command: "/usr/bin/node",
			args: ["child-entry.js", "--print", "hello"],
			environment: { PATH: "/usr/bin:/bin" },
			workspace: workspace(),
			dependencies: { createBackend: () => enforcing },
		});
		expect(code).toBe(23);
		expect(enforcing.launches).toHaveLength(1);
		expect(enforcing.launches[0]).toMatchObject({
			command: "/usr/bin/node",
			args: ["child-entry.js", "--print", "hello"],
		});
		expect(enforcing.closed).toBe(true);
	});

	it("fails closed and does not start a child when enforcement is unavailable", async () => {
		const unavailable = backend({ kind: "unavailable", reason: "Bubblewrap unavailable" });
		let stderr = "";
		const code = await launchSandboxedCli({
			command: "/usr/bin/node",
			args: ["child-entry.js"],
			environment: {},
			workspace: workspace(),
			dependencies: {
				createBackend: () => unavailable,
				stderr: {
					write: (message) => {
						stderr += message;
						return true;
					},
				},
			},
		});
		expect(code).toBe(1);
		expect(unavailable.launches).toEqual([]);
		expect(unavailable.closed).toBe(true);
		expect(stderr).toContain("Bubblewrap unavailable");
	});

	it("passes a violation store into the backend and reports recorded violations on stderr", async () => {
		let capturedStore: SandboxViolationStore | undefined;
		const enforcing: SandboxBackend & { launches: SandboxLaunch[] } = {
			status: { kind: "enforced" },
			launches: [],
			async launch(launch) {
				this.launches.push(launch);
				capturedStore?.add({
					kind: "filesystem",
					command: "/bin/sh -c 'echo x > outside'",
					detail: "bwrap: write outside workspace refused",
					timestamp: new Date(),
				});
				return 1;
			},
			async close() {},
		};
		let stderr = "";
		const code = await launchSandboxedCli({
			command: "/usr/bin/node",
			args: ["child-entry.js"],
			environment: {},
			workspace: workspace(),
			dependencies: {
				createBackend: (options) => {
					capturedStore = options.violationStore;
					return enforcing;
				},
				stderr: {
					write: (message) => {
						stderr += message;
						return true;
					},
				},
			},
		});
		expect(code).toBe(1);
		expect(stderr).toContain("filesystem");
		expect(stderr).toContain("bwrap: write outside workspace refused");
	});
});

describe.skipIf(!canEnforceLinuxSandbox())("CLI sandbox supervisor with the real backend", () => {
	it("records and reports a real outside-workspace write through the default production dependencies", async () => {
		const cwd = workspace();
		const outside = join(dirname(cwd), `cli-supervisor-outside-${Date.now()}.txt`);
		let stderr = "";
		const code = await launchSandboxedCli({
			command: "/bin/sh",
			args: ["-c", `printf blocked > ${outside}`],
			environment: {},
			workspace: cwd,
			dependencies: {
				stderr: {
					write: (message) => {
						stderr += message;
						return true;
					},
				},
			},
		});
		expect(code).not.toBe(0);
		expect(stderr).toContain("Sandbox violation (filesystem)");
	});
});

describe.skipIf(!canEnforceMacosSandbox())("CLI sandbox supervisor with the real macOS backend", () => {
	it("records and reports a real outside-workspace write through the default production dependencies", async () => {
		const cwd = workspace();
		const outside = join(dirname(cwd), `cli-supervisor-outside-${Date.now()}.txt`);
		let stderr = "";
		const code = await launchSandboxedCli({
			command: "/bin/sh",
			args: ["-c", `printf blocked > ${outside}`],
			environment: {},
			workspace: cwd,
			dependencies: {
				stderr: {
					write: (message) => {
						stderr += message;
						return true;
					},
				},
			},
		});
		expect(code).not.toBe(0);
		expect(stderr).toContain("Sandbox violation (filesystem)");
	});
});
