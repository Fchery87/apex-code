import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildSandboxedCliLaunch,
	requiresSandboxedChild,
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

		expect(resolveSupervisorAllowedHosts(cwd, agentDir)).toEqual(["provider.example"]);
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
