import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilePermissionRuleStore } from "../../src/core/permissions/store.ts";
import {
	buildSandboxedCliLaunch,
	createSupervisorStateDirectory,
	POLICY_SNAPSHOT_PATH_VARIABLE,
	SANDBOX_ENFORCEMENT_MARKER_VALUE,
	SANDBOX_ENFORCEMENT_MARKER_VARIABLE,
	writeSupervisorPolicySnapshot,
} from "../../src/core/sandbox/cli-launch.ts";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";
import { createSandboxSupervisor } from "../../src/core/sandbox/supervisor.ts";

const directories: string[] = [];
const disposals: Array<() => void> = [];

afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function scratch(prefix = "apex-supervisor-state-"): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

function canEnforceLinuxSandbox(): boolean {
	return process.platform === "linux" && createLinuxSandboxBackend().status.kind === "enforced";
}

const scope = (toolName: string, mode?: string) =>
	JSON.stringify({ version: 1, rules: [{ toolName, behavior: "allow" }], ...(mode ? { mode } : {}) });

describe("supervisor-private state directory", () => {
	it("allocates a 0700 directory outside the workspace and removes it on dispose", () => {
		const workspace = scratch();
		const state = createSupervisorStateDirectory();
		disposals.push(state.dispose);

		expect(existsSync(state.path)).toBe(true);
		expect(statSync(state.path).mode & 0o777).toBe(0o700);
		expect(state.path.startsWith(workspace)).toBe(false);

		state.dispose();
		expect(existsSync(state.path)).toBe(false);
	});
});

describe("supervisor policy snapshot", () => {
	it("captures the host managed policy and the host user scope before the child agent dir is repointed", () => {
		const host = scratch();
		const state = createSupervisorStateDirectory();
		disposals.push(state.dispose);
		const policyPath = join(host, "policy.json");
		const hostAgentDir = join(host, "agent");
		mkdirSync(hostAgentDir, { recursive: true });
		writeFileSync(policyPath, scope("bash"));
		writeFileSync(join(hostAgentDir, "permissions.json"), scope("write"));

		const snapshotPath = writeSupervisorPolicySnapshot({
			directory: state.path,
			agentDir: hostAgentDir,
			policyPath,
		});

		expect(snapshotPath.startsWith(state.path)).toBe(true);
		const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
		expect(snapshot).toMatchObject({ version: 1 });
		expect(JSON.parse(snapshot.policy)).toMatchObject({ rules: [{ toolName: "bash", behavior: "allow" }] });
		expect(JSON.parse(snapshot.user)).toMatchObject({ rules: [{ toolName: "write", behavior: "allow" }] });
	});

	it("makes the child's effective policy and user scopes equal the supervisor snapshot", async () => {
		const host = scratch();
		const state = createSupervisorStateDirectory();
		disposals.push(state.dispose);
		const policyPath = join(host, "policy.json");
		const hostAgentDir = join(host, "agent");
		mkdirSync(hostAgentDir, { recursive: true });
		writeFileSync(policyPath, scope("bash"));
		writeFileSync(join(hostAgentDir, "permissions.json"), scope("write", "acceptEdits"));
		const snapshotPath = writeSupervisorPolicySnapshot({
			directory: state.path,
			agentDir: hostAgentDir,
			policyPath,
		});

		// The child's own view: a repointed agent directory it can write, and no host
		// managed policy path reachable from inside the boundary.
		const workspace = scratch();
		const childAgentDir = join(workspace, ".apex-code", "sandbox-agent");
		mkdirSync(childAgentDir, { recursive: true });
		writeFileSync(join(childAgentDir, "permissions.json"), scope("delegate", "bypassPermissions"));

		const store = new FilePermissionRuleStore({
			cwd: workspace,
			agentDir: childAgentDir,
			policyPath: join(workspace, "no-such-policy.json"),
			policySnapshotPath: snapshotPath,
		});
		const snapshot = await store.snapshot();

		expect(snapshot.errors).toEqual([]);
		expect(snapshot.rules.filter((rule) => rule.source === "policy")).toEqual([
			{ source: "policy", toolName: "bash", behavior: "allow" },
		]);
		expect(snapshot.rules.filter((rule) => rule.source === "user")).toEqual([
			{ source: "user", toolName: "write", behavior: "allow" },
		]);
		// The child-writable copy must not be able to name its own mode either.
		expect(snapshot.modesBySource.get("user")).toBe("acceptEdits");
	});

	it("bases a user update on the supervisor snapshot before the first read", async () => {
		const host = scratch();
		const state = createSupervisorStateDirectory();
		disposals.push(state.dispose);
		const hostAgentDir = join(host, "agent");
		mkdirSync(hostAgentDir, { recursive: true });
		writeFileSync(join(hostAgentDir, "permissions.json"), scope("write"));
		const snapshotPath = writeSupervisorPolicySnapshot({
			directory: state.path,
			agentDir: hostAgentDir,
			policyPath: join(host, "missing-policy.json"),
		});

		const workspace = scratch();
		const childAgentDir = join(workspace, ".apex-code", "sandbox-agent");
		mkdirSync(childAgentDir, { recursive: true });
		writeFileSync(join(childAgentDir, "permissions.json"), scope("delegate"));
		const store = new FilePermissionRuleStore({
			cwd: workspace,
			agentDir: childAgentDir,
			policySnapshotPath: snapshotPath,
		});

		await store.apply({
			type: "addRules",
			destination: "user",
			rules: [{ toolName: "read", behavior: "allow" }],
		});
		const userRules = (await store.snapshot()).rules.filter((rule) => rule.source === "user");

		expect(userRules).toEqual([
			{ source: "user", toolName: "write", behavior: "allow" },
			{ source: "user", toolName: "read", behavior: "allow" },
		]);
		expect(userRules).not.toContainEqual({ source: "user", toolName: "delegate", behavior: "allow" });
	});

	it("reads the snapshot path from the supervisor-set environment variable by default", async () => {
		const host = scratch();
		const state = createSupervisorStateDirectory();
		disposals.push(state.dispose);
		const policyPath = join(host, "policy.json");
		const hostAgentDir = join(host, "agent");
		mkdirSync(hostAgentDir, { recursive: true });
		writeFileSync(policyPath, scope("bash"));
		const snapshotPath = writeSupervisorPolicySnapshot({
			directory: state.path,
			agentDir: hostAgentDir,
			policyPath,
		});

		const previous = process.env[POLICY_SNAPSHOT_PATH_VARIABLE];
		process.env[POLICY_SNAPSHOT_PATH_VARIABLE] = snapshotPath;
		try {
			const workspace = scratch();
			const store = new FilePermissionRuleStore({ cwd: workspace, agentDir: join(workspace, "agent") });
			expect((await store.snapshot()).rules).toContainEqual({
				source: "policy",
				toolName: "bash",
				behavior: "allow",
			});
		} finally {
			if (previous === undefined) delete process.env[POLICY_SNAPSHOT_PATH_VARIABLE];
			else process.env[POLICY_SNAPSHOT_PATH_VARIABLE] = previous;
		}
	});

	it("records a snapshot parse failure as a source error rather than silently allowing", async () => {
		const state = createSupervisorStateDirectory();
		disposals.push(state.dispose);
		const workspace = scratch();
		const snapshotPath = join(state.path, "policy", "permission-snapshot.json");
		mkdirSync(join(state.path, "policy"), { recursive: true });
		writeFileSync(snapshotPath, "{ not json");

		const store = new FilePermissionRuleStore({
			cwd: workspace,
			agentDir: join(workspace, "agent"),
			policySnapshotPath: snapshotPath,
		});
		const snapshot = await store.snapshot();

		expect(snapshot.rules.filter((rule) => rule.source === "policy" || rule.source === "user")).toEqual([]);
		expect(snapshot.errors.map((entry) => entry.source)).toContain("policy");
	});
});

describe("sandboxed CLI launch state projection", () => {
	it("names the snapshot and the enforcement marker to the child without accepting either from the shell", () => {
		const workspace = scratch();
		const state = createSupervisorStateDirectory();
		disposals.push(state.dispose);
		const snapshotPath = join(state.path, "policy", "permission-snapshot.json");

		const launch = buildSandboxedCliLaunch({
			workspace,
			command: "/usr/bin/node",
			args: ["cli.js"],
			environment: {
				PATH: "/usr/bin:/bin",
				[SANDBOX_ENFORCEMENT_MARKER_VARIABLE]: "forged-by-the-shell",
				[POLICY_SNAPSHOT_PATH_VARIABLE]: "/tmp/forged-snapshot.json",
			},
			supervisorStateDirectory: state.path,
			policySnapshotPath: snapshotPath,
		});

		expect(launch.environment[SANDBOX_ENFORCEMENT_MARKER_VARIABLE]).toBe(SANDBOX_ENFORCEMENT_MARKER_VALUE);
		expect(launch.environment[POLICY_SNAPSHOT_PATH_VARIABLE]).toBe(snapshotPath);
		expect(launch.supervisorStateDirectory).toBe(state.path);
	});

	it("names no snapshot when the supervisor captured none, and still owns the marker value", () => {
		const workspace = scratch();
		const launch = buildSandboxedCliLaunch({
			workspace,
			command: "/usr/bin/node",
			args: ["cli.js"],
			environment: { PATH: "/usr/bin:/bin", [SANDBOX_ENFORCEMENT_MARKER_VARIABLE]: "forged-by-the-shell" },
		});
		// The child-environment allowlist must never carry either value through from the
		// invoking shell; the supervisor's own resolution is the only source (ADR 0016).
		expect(launch.environment[SANDBOX_ENFORCEMENT_MARKER_VARIABLE]).toBe(SANDBOX_ENFORCEMENT_MARKER_VALUE);
		expect(launch.environment[POLICY_SNAPSHOT_PATH_VARIABLE]).toBeUndefined();
	});
});

describe.skipIf(!canEnforceLinuxSandbox())("supervisor state under the real Linux boundary", () => {
	it("projects the supervisor state directory and the policy snapshot read-only into the child", async () => {
		const workspace = scratch();
		const state = createSupervisorStateDirectory();
		disposals.push(state.dispose);
		const host = scratch();
		const hostAgentDir = join(host, "agent");
		mkdirSync(hostAgentDir, { recursive: true });
		writeFileSync(join(host, "policy.json"), scope("bash"));
		const snapshotPath = writeSupervisorPolicySnapshot({
			directory: state.path,
			agentDir: hostAgentDir,
			policyPath: join(host, "policy.json"),
		});

		const backend = createLinuxSandboxBackend();
		const supervisor = createSandboxSupervisor({
			backend,
			policy: { workspace, allowedHosts: [], additionalWritableRoots: [] },
		});
		try {
			// Readable, because policy the child must obey has to reach it.
			await expect(
				supervisor.launch({
					command: "/bin/sh",
					args: ["-c", `grep -q '"version"' ${snapshotPath}`],
					supervisorStateDirectory: state.path,
				}),
			).resolves.toBe(0);
			// Not writable, which is what makes it a snapshot rather than a suggestion.
			await expect(
				supervisor.launch({
					command: "/bin/sh",
					args: ["-c", `printf widened > ${snapshotPath}`],
					supervisorStateDirectory: state.path,
				}),
			).resolves.not.toBe(0);
			await expect(
				supervisor.launch({
					command: "/bin/sh",
					args: ["-c", `ln -sf /etc/hostname ${join(state.path, "terminal-handoff")}`],
					supervisorStateDirectory: state.path,
				}),
			).resolves.not.toBe(0);
			expect(readFileSync(snapshotPath, "utf8")).toContain('"version"');
		} finally {
			await supervisor.close();
		}
	});

	it("keeps the handoff command file and the relay out of the child-writable workspace", async () => {
		const workspace = scratch();
		const state = createSupervisorStateDirectory();
		disposals.push(state.dispose);
		const backend = createLinuxSandboxBackend();
		const supervisor = createSandboxSupervisor({
			backend,
			policy: { workspace, allowedHosts: [], additionalWritableRoots: [] },
		});
		try {
			await expect(
				supervisor.launch({
					command: "/bin/sh",
					args: [
						"-c",
						`test "$APEX_TERMINAL_HANDOFF_PATH" = "${state.path}" && ` +
							`test ! -e "${join(workspace, ".apex-code", "sandbox-state", "relay.cjs")}" && ` +
							`test ! -e "${join(workspace, ".apex-code", "sandbox-state", "terminal-handoff")}"`,
					],
					supervisorStateDirectory: state.path,
				}),
			).resolves.toBe(0);
		} finally {
			await supervisor.close();
		}
	});
});
