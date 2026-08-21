/**
 * SKILL.1 — the failing repro for `docs/plans/2026-08-20-sandbox-skill-projection.md`.
 *
 * Phase 2b's whole-CLI launch hides host-home and repoints `HOME` and the agent
 * directory into the workspace (`core/sandbox/cli-launch.ts`, ADR 0005). The skills
 * subsystem computes its user-scope discovery roots from exactly those two values
 * (`core/package-manager.ts`'s `userDirs.skills` and `userAgentsSkillsDir`), so a
 * sandboxed session resolves both roots to empty workspace paths and loads nothing.
 *
 * The child's environment comes from the real `buildSandboxedCliLaunch` rather than
 * hand-written constants, so this cannot drift from what the supervisor actually sets.
 * No enforced sandbox is required: the defect is path computation, not mount
 * enforcement, so this runs in every CI job instead of only the Linux one. SKILL.4
 * covers the mount itself against real `bwrap` and `sandbox-exec` children.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { buildSandboxedCliLaunch } from "../../src/core/sandbox/cli-launch.ts";

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

async function discoveredNames(options: { cwd: string; agentDir: string; homeDir: string }): Promise<string[]> {
	const previousHome = process.env.HOME;
	process.env.HOME = options.homeDir;
	try {
		const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.agentDir });
		await loader.reload();
		return loader
			.getSkills()
			.skills.map((skill) => skill.name)
			.sort();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
}

describe("user-scope skill discovery across the sandbox boundary", () => {
	it("discovers both user-scope roots when the host environment is used", async () => {
		const { agentDir, homeDir } = hostLayout();

		const names = await discoveredNames({ cwd: scratch("apex-skill-ws-"), agentDir, homeDir });

		expect(names).toEqual(["agent-root-skill", "agents-root-skill"]);
	});

	it("discovers the same skills under the environment the supervisor gives the child", async () => {
		// The host layout is still written; the child simply cannot compute its way to it.
		const { homeDir } = hostLayout();
		const workspace = scratch("apex-skill-ws-");
		const launch = buildSandboxedCliLaunch({
			workspace,
			command: process.execPath,
			args: ["cli.js"],
			environment: { HOME: homeDir, PATH: process.env.PATH ?? "" },
		});

		const names = await discoveredNames({
			cwd: workspace,
			agentDir: launch.environment.APEX_CODE_CODING_AGENT_DIR as string,
			homeDir: launch.environment.HOME as string,
		});

		expect(names).toEqual(["agent-root-skill", "agents-root-skill"]);
	});
});
