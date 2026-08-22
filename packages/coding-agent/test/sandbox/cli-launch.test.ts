import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSandboxedCliLaunch,
	requiresSandboxedChild,
	resolveHostSkillPaths,
	resolveSupervisorAllowedHosts,
} from "../../src/core/sandbox/cli-launch.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function workspace(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-sandbox-cli-"));
	directories.push(directory);
	return directory;
}

describe("sandbox CLI launch", () => {
	it("gives the child private agent and session state inside its writable workspace", () => {
		const cwd = workspace();
		const authPath = join(cwd, "host-auth.json");
		const launch = buildSandboxedCliLaunch({
			workspace: cwd,
			command: "/usr/bin/node",
			args: ["cli.js", "--print", "hello"],
			environment: {
				PATH: "/usr/bin:/bin",
				HOME: "/host-home",
				OPENAI_API_KEY: "secret",
				APEX_CODE_OFFLINE: "1",
				AWS_SECRET_ACCESS_KEY: "secret-aws",
				HOST_SECRET: "must-not-pass",
				HTTP_PROXY: "http://attacker.invalid",
			},
			authPath,
		});

		expect(launch).toMatchObject({
			command: "/usr/bin/node",
			args: ["cli.js", "--print", "hello"],
			policy: { workspace: cwd, allowedHosts: [] },
		});
		expect(launch.environment).toMatchObject({
			APEX_CODE_CODING_AGENT_DIR: join(cwd, ".apex-code", "sandbox-agent"),
			APEX_CODE_CODING_AGENT_SESSION_DIR: join(cwd, ".apex-code", "sandbox-sessions"),
			HOME: join(cwd, ".apex-code", "sandbox-state"),
			XDG_CONFIG_HOME: join(cwd, ".apex-code", "sandbox-state", "config"),
			XDG_CACHE_HOME: join(cwd, ".apex-code", "sandbox-state", "cache"),
			XDG_DATA_HOME: join(cwd, ".apex-code", "sandbox-state", "data"),
			XDG_STATE_HOME: join(cwd, ".apex-code", "sandbox-state", "state"),
		});
		expect(launch.environment.PATH).toBe("/usr/bin:/bin");
		expect(launch.environment.OPENAI_API_KEY).toBe("secret");
		expect(launch.environment.AWS_SECRET_ACCESS_KEY).toBe("secret-aws");
		expect(launch.environment.APEX_CODE_OFFLINE).toBe("1");
		expect(launch.environment.HOST_SECRET).toBeUndefined();
		expect(launch.environment.HTTP_PROXY).toBeUndefined();
		expect(launch.environment.APEX_CODE_AUTH_PATH).toBe(authPath);
		expect(launch.readOnlyPaths).toEqual([]);
		expect(launch.readOnlyFiles).toEqual([authPath]);
	});

	it("projects host tool executables at the paths the child already looks in", () => {
		const cwd = workspace();
		const hostToolsDirectory = workspace();
		const fdSource = join(hostToolsDirectory, "fdfind");
		writeFileSync(fdSource, "#!/bin/sh\n", { mode: 0o755 });

		const launch = buildSandboxedCliLaunch({
			workspace: cwd,
			command: "/usr/bin/node",
			args: [],
			environment: {},
			toolBinaries: [{ name: "fd", path: fdSource }],
		});

		// The destination is the child's own getBinDir(), so the child finds the tool
		// through its existing lookup instead of attempting a download.
		expect(launch.readOnlyBinaries).toEqual([
			{ source: fdSource, destination: join(cwd, ".apex-code", "sandbox-agent", "bin", "fd") },
		]);
		expect(existsSync(join(cwd, ".apex-code", "sandbox-agent", "bin"))).toBe(true);
	});

	it("projects nothing when the host has no managed tools to offer", () => {
		const cwd = workspace();
		const launch = buildSandboxedCliLaunch({ workspace: cwd, command: "/usr/bin/node", args: [], environment: {} });
		expect(launch.readOnlyBinaries).toEqual([]);
	});

	it("clears a stale mountpoint stub for a tool it is no longer projecting", () => {
		const cwd = workspace();
		const toolsDirectory = join(cwd, ".apex-code", "sandbox-agent", "bin");
		mkdirSync(toolsDirectory, { recursive: true });
		// Left behind by a previous launch's bind mount, after the host tool went away.
		writeFileSync(join(toolsDirectory, "fd"), "", { mode: 0o444 });
		// A genuinely downloaded binary from before the sandbox existed must survive.
		writeFileSync(join(toolsDirectory, "rg"), "#!/bin/sh\n", { mode: 0o755 });

		buildSandboxedCliLaunch({ workspace: cwd, command: "/usr/bin/node", args: [], environment: {} });

		expect(existsSync(join(toolsDirectory, "fd"))).toBe(false);
		expect(existsSync(join(toolsDirectory, "rg"))).toBe(true);
	});

	it("keeps supervision state out of the child environment", () => {
		const cwd = workspace();
		const launch = buildSandboxedCliLaunch({ workspace: cwd, command: "/usr/bin/node", args: [], environment: {} });
		expect(launch.environment).not.toHaveProperty("APEX_CODE_SANDBOX_CHILD");
	});

	it("ignores project network policy before trust is established", () => {
		const cwd = workspace();
		const agentDir = workspace();
		mkdirSync(join(cwd, ".apex-code"), { recursive: true });
		writeFileSync(
			join(cwd, ".apex-code", "settings.json"),
			JSON.stringify({ network: { allowedHosts: ["attacker.example"] } }),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ network: { allowedHosts: ["provider.example"] } }),
		);

		const resolved = resolveSupervisorAllowedHosts(cwd, agentDir) ?? [];
		expect(resolved).toContain("provider.example");
		expect(resolved).not.toContain("attacker.example");
	});

	it("permits the model providers a fresh install has no way to know it needs", () => {
		const agentDir = workspace();
		// No settings file at all: the shipped default, which previously denied everything
		// and left a first run failing with no usable indication of why.
		const resolved = resolveSupervisorAllowedHosts(workspace(), agentDir) ?? [];

		expect(resolved).toContain("generativelanguage.googleapis.com");
		expect(resolved).toContain("api.anthropic.com");
	});

	it("honours an explicit opt-out back to deny-all plus whatever was configured", () => {
		const agentDir = workspace();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ network: { allowDefaultHosts: false, allowedHosts: ["only.example"] } }),
		);

		expect(resolveSupervisorAllowedHosts(workspace(), agentDir)).toEqual(["only.example"]);
	});

	it("mounts host skill roots read-only and tells the child where each one is, by name (SKILL.2)", () => {
		const cwd = workspace();
		const agentSkillsDir = join(workspace(), "agent-skills");
		const agentsHomeSkillsDir = join(workspace(), "agents-home-skills");

		const launch = buildSandboxedCliLaunch({
			workspace: cwd,
			command: "/usr/bin/node",
			args: [],
			environment: {},
			skillPaths: { agentSkills: agentSkillsDir, agentsHomeSkills: agentsHomeSkillsDir },
		});

		expect(launch.readOnlyPaths).toEqual(expect.arrayContaining([agentSkillsDir, agentsHomeSkillsDir]));
		expect(launch.environment.APEX_CODE_SKILL_PATH_AGENT).toBe(agentSkillsDir);
		expect(launch.environment.APEX_CODE_SKILL_PATH_AGENTS_HOME).toBe(agentsHomeSkillsDir);
	});

	it("mounts only the one skill root that exists, still identified by name (SKILL.2)", () => {
		const cwd = workspace();
		const agentsHomeSkillsDir = join(workspace(), "agents-home-skills");

		const launch = buildSandboxedCliLaunch({
			workspace: cwd,
			command: "/usr/bin/node",
			args: [],
			environment: {},
			skillPaths: { agentsHomeSkills: agentsHomeSkillsDir },
		});

		expect(launch.readOnlyPaths).toEqual([agentsHomeSkillsDir]);
		expect(launch.environment.APEX_CODE_SKILL_PATH_AGENT).toBeUndefined();
		expect(launch.environment.APEX_CODE_SKILL_PATH_AGENTS_HOME).toBe(agentsHomeSkillsDir);
	});

	it("adds no skill mounts or env vars when the host has no skill roots to offer (SKILL.2)", () => {
		const cwd = workspace();

		const launch = buildSandboxedCliLaunch({ workspace: cwd, command: "/usr/bin/node", args: [], environment: {} });

		expect(launch.readOnlyPaths).toEqual([]);
		expect(launch.environment.APEX_CODE_SKILL_PATH_AGENT).toBeUndefined();
		expect(launch.environment.APEX_CODE_SKILL_PATH_AGENTS_HOME).toBeUndefined();
	});

	it("keeps the supervisor's skill paths authoritative over anything an env var already carried (SKILL.2)", () => {
		const cwd = workspace();
		const trustedRoot = join(workspace(), "trusted-skills");

		const launch = buildSandboxedCliLaunch({
			workspace: cwd,
			command: "/usr/bin/node",
			args: [],
			environment: { APEX_CODE_SKILL_PATH_AGENT: "/attacker/controlled/path" },
			skillPaths: { agentSkills: trustedRoot },
		});

		expect(launch.environment.APEX_CODE_SKILL_PATH_AGENT).toBe(trustedRoot);
	});

	it("resolves only the host skill roots that actually exist, keyed by name (SKILL.2)", () => {
		const agentDir = workspace();
		const homeDir = workspace();
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		// No .agents/skills under homeDir -- this root is absent and must be omitted.

		const resolved = resolveHostSkillPaths(agentDir, homeDir);

		expect(resolved).toEqual({ paths: { agentSkills: join(agentDir, "skills") }, refusals: [] });
	});

	it("resolves both host skill roots when both exist (SKILL.2)", () => {
		const agentDir = workspace();
		const homeDir = workspace();
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		mkdirSync(join(homeDir, ".agents", "skills"), { recursive: true });

		const resolved = resolveHostSkillPaths(agentDir, homeDir);

		expect(resolved).toEqual({
			paths: {
				agentSkills: join(agentDir, "skills"),
				agentsHomeSkills: join(homeDir, ".agents", "skills"),
			},
			refusals: [],
		});
	});

	it("resolves no host skill roots when neither exists (SKILL.2)", () => {
		const agentDir = workspace();
		const homeDir = workspace();

		expect(resolveHostSkillPaths(agentDir, homeDir)).toEqual({ paths: {}, refusals: [] });
	});

	it("refuses a skill root symlinked directly at the host home (SKILL.4)", () => {
		const agentDir = workspace();
		const homeDir = workspace();
		symlinkSync(homeDir, join(agentDir, "skills"));

		const resolved = resolveHostSkillPaths(agentDir, homeDir);

		expect(resolved.paths.agentSkills).toBeUndefined();
		expect(resolved.refusals).toEqual([
			expect.objectContaining({ root: "agentSkills", path: join(agentDir, "skills") }),
		]);
	});

	it("refuses a skill root symlinked at an ancestor of the host home (SKILL.4)", () => {
		const agentDir = workspace();
		const homeParent = workspace();
		const homeDir = join(homeParent, "home");
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(join(homeDir, ".agents"), { recursive: true });
		// Points above $HOME itself -- mounting this would re-expose every sibling of
		// $HOME under homeParent, not just the intended skills subtree.
		symlinkSync(homeParent, join(homeDir, ".agents", "skills"));

		const resolved = resolveHostSkillPaths(agentDir, homeDir);

		expect(resolved.paths.agentsHomeSkills).toBeUndefined();
		expect(resolved.refusals).toEqual([
			expect.objectContaining({ root: "agentsHomeSkills", path: join(homeDir, ".agents", "skills") }),
		]);
	});

	it("accepts a skill root symlinked to an unrelated, safe directory (SKILL.4)", () => {
		const agentDir = workspace();
		const homeDir = workspace();
		const realSkillsDir = workspace();
		mkdirSync(join(homeDir, ".agents"), { recursive: true });
		symlinkSync(realSkillsDir, join(homeDir, ".agents", "skills"));

		const resolved = resolveHostSkillPaths(agentDir, homeDir);

		expect(resolved.paths.agentsHomeSkills).toBe(join(homeDir, ".agents", "skills"));
		expect(resolved.refusals).toEqual([]);
	});

	it("routes every agent-session shape through the child while exempting only non-session commands", () => {
		expect(requiresSandboxedChild(["--print", "hello"])).toBe(true);
		expect(requiresSandboxedChild(["--mode", "rpc"])).toBe(true);
		expect(requiresSandboxedChild([])).toBe(true);
		expect(requiresSandboxedChild(["--version"])).toBe(false);
		expect(requiresSandboxedChild(["--help"])).toBe(false);
		expect(requiresSandboxedChild(["--help", "--print"])).toBe(false);
		expect(requiresSandboxedChild(["auth", "check", "--provider", "test"])).toBe(false);
		expect(requiresSandboxedChild(["config"])).toBe(false);
	});
});

describe("sandbox CLI launch credential channel", () => {
	it("advertises the channel socket to the child only when the supervisor opened one", () => {
		const cwd = workspace();
		const withChannel = buildSandboxedCliLaunch({
			workspace: cwd,
			command: "/usr/bin/node",
			args: ["cli.js"],
			environment: { PATH: "/usr/bin:/bin" },
			credentialChannel: { hostSocketPath: "/tmp/apex-cred.sock", childSocketPath: "/home/apex-cred.sock" },
		});
		expect(withChannel.environment.APEX_CREDENTIAL_PROXY_PATH).toBe("/home/apex-cred.sock");

		const withoutChannel = buildSandboxedCliLaunch({
			workspace: cwd,
			command: "/usr/bin/node",
			args: ["cli.js"],
			environment: { PATH: "/usr/bin:/bin" },
		});
		expect(withoutChannel.environment.APEX_CREDENTIAL_PROXY_PATH).toBeUndefined();
	});

	it("lets the supervisor's resolution win over anything the invoking shell exported", () => {
		const cwd = workspace();
		const launch = buildSandboxedCliLaunch({
			workspace: cwd,
			command: "/usr/bin/node",
			args: ["cli.js"],
			// APEX_CREDENTIAL_PROXY_PATH is not in the child env allowlist, but the
			// same rule as APEX_CODE_AUTH_PATH applies: the supervisor's channel is
			// its own resolution and must never be spoofable from outside.
			environment: { PATH: "/usr/bin:/bin", APEX_CREDENTIAL_PROXY_PATH: "/tmp/attacker.sock" },
			credentialChannel: { hostSocketPath: "/tmp/apex-cred.sock", childSocketPath: "/home/apex-cred.sock" },
		});
		expect(launch.environment.APEX_CREDENTIAL_PROXY_PATH).toBe("/home/apex-cred.sock");
	});
});
