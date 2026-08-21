/**
 * SKILL.1 — the failing repro for `docs/plans/2026-08-20-sandbox-skill-projection.md`.
 *
 * Phase 2b's whole-CLI launch hides host-home and repoints `HOME` and the agent
 * directory into the workspace (`core/sandbox/cli-launch.ts`, ADR 0005). The skills
 * subsystem computes its user-scope discovery roots from exactly those two values
 * (`core/package-manager.ts`'s `userDirs.skills` and `userAgentsSkillsDir`), so a
 * sandboxed session resolves both roots to empty workspace paths and loads nothing.
 *
 * The second case drives the exact chain `cli.ts` drives in production --
 * `resolveHostSkillPaths` then `buildSandboxedCliLaunch` -- rather than hand-written
 * constants, so it cannot drift from what the supervisor actually does. No enforced
 * sandbox is required: the defect is path computation, not mount enforcement, so this
 * runs in every CI job instead of only the Linux one. SKILL.4 covers the mount itself
 * against real `bwrap` and `sandbox-exec` children.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { buildSandboxedCliLaunch, resolveHostSkillPaths } from "../../src/core/sandbox/cli-launch.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function scratch(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

function writeSkill(root: string, name: string): void {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: Fixture skill ${name} used by the sandbox discovery repro.\n---\n\nBody.\n`,
	);
}

/** A host layout with one skill in each of the two user-scope roots. */
function hostLayout(): { agentDir: string; homeDir: string } {
	const agentDir = scratch("apex-skill-agent-");
	const homeDir = scratch("apex-skill-home-");
	writeSkill(join(agentDir, "skills"), "agent-root-skill");
	writeSkill(join(homeDir, ".agents", "skills"), "agents-root-skill");
	return { agentDir, homeDir };
}

/**
 * Runs discovery with the given environment variables set, restoring whatever was
 * there before (including "not set at all") afterward. Mirrors a real child process's
 * environment more faithfully than mutating only `HOME`, since the fix threads
 * additional `APEX_CODE_SKILL_PATH_*` variables through the same channel.
 */
async function discoveredNames(options: {
	cwd: string;
	agentDir: string;
	env: Readonly<Record<string, string | undefined>>;
}): Promise<string[]> {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(options.env)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.agentDir });
		await loader.reload();
		return loader
			.getSkills()
			.skills.map((skill) => skill.name)
			.sort();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("user-scope skill discovery across the sandbox boundary", () => {
	it("discovers both user-scope roots when the host environment is used", async () => {
		const { agentDir, homeDir } = hostLayout();

		const names = await discoveredNames({
			cwd: scratch("apex-skill-ws-"),
			agentDir,
			env: { HOME: homeDir },
		});

		expect(names).toEqual(["agent-root-skill", "agents-root-skill"]);
	});

	it("discovers the same skills through the real resolve-then-launch chain cli.ts drives", async () => {
		// The host layout is still written; the child simply cannot compute its way to
		// it unless the supervisor resolves and threads the roots through, as cli.ts does.
		const { agentDir, homeDir } = hostLayout();
		const workspace = scratch("apex-skill-ws-");
		const skillPaths = resolveHostSkillPaths(agentDir, homeDir);
		const launch = buildSandboxedCliLaunch({
			workspace,
			command: process.execPath,
			args: ["cli.js"],
			environment: { HOME: homeDir, PATH: process.env.PATH ?? "" },
			skillPaths,
		});

		const names = await discoveredNames({
			cwd: workspace,
			agentDir: launch.environment.APEX_CODE_CODING_AGENT_DIR as string,
			env: {
				HOME: launch.environment.HOME,
				APEX_CODE_SKILL_PATH_AGENT: launch.environment.APEX_CODE_SKILL_PATH_AGENT,
				APEX_CODE_SKILL_PATH_AGENTS_HOME: launch.environment.APEX_CODE_SKILL_PATH_AGENTS_HOME,
			},
		});

		expect(names).toEqual(["agent-root-skill", "agents-root-skill"]);
	});

	it("keeps each mounted root's discovery mode: root .md counts under the agent root, is ignored under the agents-home root", async () => {
		const agentDir = scratch("apex-skill-agent-");
		const homeDir = scratch("apex-skill-home-");
		const agentSkillsDir = join(agentDir, "skills");
		const agentsHomeSkillsDir = join(homeDir, ".agents", "skills");
		mkdirSync(agentSkillsDir, { recursive: true });
		mkdirSync(agentsHomeSkillsDir, { recursive: true });
		const rootMdContent =
			"---\nname: root-flat-skill\ndescription: A root .md file with no SKILL.md wrapper.\n---\n\nBody.\n";
		writeFileSync(join(agentSkillsDir, "root-flat-skill.md"), rootMdContent);
		writeFileSync(join(agentsHomeSkillsDir, "root-flat-skill.md"), rootMdContent);

		const workspace = scratch("apex-skill-ws-");
		const skillPaths = resolveHostSkillPaths(agentDir, homeDir);
		const launch = buildSandboxedCliLaunch({
			workspace,
			command: process.execPath,
			args: ["cli.js"],
			environment: { HOME: homeDir, PATH: process.env.PATH ?? "" },
			skillPaths,
		});

		const names = await discoveredNames({
			cwd: workspace,
			agentDir: launch.environment.APEX_CODE_CODING_AGENT_DIR as string,
			env: {
				HOME: launch.environment.HOME,
				APEX_CODE_SKILL_PATH_AGENT: launch.environment.APEX_CODE_SKILL_PATH_AGENT,
				APEX_CODE_SKILL_PATH_AGENTS_HOME: launch.environment.APEX_CODE_SKILL_PATH_AGENTS_HOME,
			},
		});

		// Only the agent-root copy is discovered under "pi" mode; the agents-home
		// copy is silently ignored under "agents" mode, matching the unsandboxed
		// behavior docs/skills.md documents for these two roots.
		expect(names).toEqual(["root-flat-skill"]);
	});
});
