import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { resolveSandboxProfile } from "../../src/core/sandbox/profiles.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function scratch(): string {
	const directory = mkdtempSync(join(tmpdir(), "apex-sandbox-profile-"));
	directories.push(directory);
	return directory;
}

/** A host agent dir holding global settings, and a workspace holding project settings. */
function scopes(global: unknown, project?: unknown): { agentDir: string; cwd: string } {
	const agentDir = scratch();
	const cwd = scratch();
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global));
	if (project !== undefined) {
		mkdirSync(join(cwd, ".apex-code"), { recursive: true });
		writeFileSync(join(cwd, ".apex-code", "settings.json"), JSON.stringify(project));
	}
	return { agentDir, cwd };
}

describe("sandbox profile arguments", () => {
	it("reads the profile name from the command line", () => {
		expect(parseArgs(["--permission-profile", "release"]).permissionProfile).toBe("release");
	});

	it("reports a missing value instead of silently ignoring the flag", () => {
		const parsed = parseArgs(["--permission-profile"]);

		expect(parsed.permissionProfile).toBeUndefined();
		expect(parsed.diagnostics.some((d) => d.type === "error")).toBe(true);
	});
});

describe("sandbox profile resolution", () => {
	it("resolves a named profile from global settings", () => {
		const { agentDir, cwd } = scopes({
			sandboxProfiles: { release: { allowedHosts: ["github.com"], additionalWritableRoots: ["/srv/out"] } },
		});

		expect(resolveSandboxProfile("release", cwd, agentDir)).toEqual({
			allowedHosts: ["github.com"],
			additionalWritableRoots: ["/srv/out"],
		});
	});

	it("ignores a profile that exists only in project settings", () => {
		// The whole point of ADR 0016: a repository that could define the boundary it runs
		// under would be granting itself authority. Naming one that does not exist globally
		// resolves to nothing, exactly as naming a profile nobody defined does.
		const { agentDir, cwd } = scopes(
			{},
			{ sandboxProfiles: { escape: { allowedHosts: ["evil.invalid"], additionalWritableRoots: ["/"] } } },
		);

		expect(resolveSandboxProfile("escape", cwd, agentDir)).toBeUndefined();
	});

	it("does not let a project profile shadow a global one of the same name", () => {
		const { agentDir, cwd } = scopes(
			{ sandboxProfiles: { release: { allowedHosts: ["github.com"] } } },
			{ sandboxProfiles: { release: { allowedHosts: ["evil.invalid"], additionalWritableRoots: ["/"] } } },
		);

		expect(resolveSandboxProfile("release", cwd, agentDir)).toEqual({
			allowedHosts: ["github.com"],
			additionalWritableRoots: [],
		});
	});

	it("resolves nothing for a name no profile defines", () => {
		const { agentDir, cwd } = scopes({ sandboxProfiles: { release: { allowedHosts: [] } } });

		expect(resolveSandboxProfile("absent", cwd, agentDir)).toBeUndefined();
	});

	it("resolves nothing when no profile was asked for", () => {
		const { agentDir, cwd } = scopes({ sandboxProfiles: { release: { allowedHosts: [] } } });

		expect(resolveSandboxProfile(undefined, cwd, agentDir)).toBeUndefined();
	});

	it("fills both fields so a partial profile cannot leave one undefined", () => {
		const { agentDir, cwd } = scopes({ sandboxProfiles: { hosts: { allowedHosts: ["github.com"] } } });

		expect(resolveSandboxProfile("hosts", cwd, agentDir)).toEqual({
			allowedHosts: ["github.com"],
			additionalWritableRoots: [],
		});
	});

	it("cannot turn the sandbox off, whatever a profile says", () => {
		// A profile widens what is reachable and writable. It has no way to express "no
		// boundary", because that is the one decision ADR 0005's amendment keeps on the
		// command line where a human has to type it.
		const { agentDir, cwd } = scopes({
			sandboxProfiles: { sneaky: { sandbox: "danger-full-access", allowedHosts: [] } },
		});

		const profile = resolveSandboxProfile("sneaky", cwd, agentDir);
		expect(profile).toBeDefined();
		expect(Object.keys(profile as object).sort()).toEqual(["additionalWritableRoots", "allowedHosts"]);
	});
});
