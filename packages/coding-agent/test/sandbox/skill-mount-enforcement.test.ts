/**
 * SKILL.4 — enforced backend proof for the skill-root mount. SKILL.2 already proved
 * `buildSandboxedCliLaunch` produces the right mount instruction and environment
 * variables against a fake backend; this proves a real `bwrap` (Linux) / `sandbox-exec`
 * (macOS) child actually honors it: the mounted file is readable at its original host
 * path, and a write into it is refused and recorded.
 *
 * Mirrors `test/sandbox/cli-supervisor.test.ts`'s existing real-backend pattern (a
 * shell probe through `launchSandboxedCli`, asserting exit code and the violation
 * text in stderr) rather than re-proving skill *discovery*, which
 * `test/sandbox/skill-discovery.test.ts` already covers against the real
 * `DefaultResourceLoader`. What's new here is specifically the mount and its
 * read-only enforcement, under a real sandbox.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchSandboxedCli } from "../../src/core/sandbox/cli-supervisor.ts";
import { createLinuxSandboxBackend } from "../../src/core/sandbox/linux-backend.ts";
import { createMacosSandboxBackend } from "../../src/core/sandbox/macos-backend.ts";

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

function workspace(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

/** A host skill root containing one marker file, mounted the way SKILL.2 mounts it. */
function hostSkillRoot(): { skillsDir: string; markerPath: string } {
	const skillsDir = workspace("apex-sandbox-skill-mount-");
	const markerPath = join(skillsDir, "marker.txt");
	writeFileSync(markerPath, "host-owned-skill-marker");
	return { skillsDir, markerPath };
}

describe.skipIf(!canEnforceLinuxSandbox())("skill root mount under the real Linux sandbox", () => {
	it("reads a mounted skill file's real content at its original host path", async () => {
		const cwd = workspace("apex-sandbox-skill-mount-ws-");
		const { skillsDir, markerPath } = hostSkillRoot();
		// launchSandboxedCli's dependencies don't expose the child's stdout, so the
		// child copies the marker into the one place the host can read back afterward:
		// its own writable workspace. This proves both readability and correct
		// content, not just a nonzero-vs-zero exit code.
		const resultPath = join(cwd, "result.txt");

		const code = await launchSandboxedCli({
			command: "/bin/sh",
			args: ["-c", `cat ${markerPath} > ${resultPath}`],
			environment: {},
			workspace: cwd,
			skillPaths: { agentSkills: skillsDir },
			dependencies: {
				stderr: { write: () => true },
			},
		});

		expect(code).toBe(0);
		expect(readFileSync(resultPath, "utf8")).toBe("host-owned-skill-marker");
	});

	it("refuses a write into a mounted skill directory", async () => {
		const cwd = workspace("apex-sandbox-skill-mount-ws-");
		const { skillsDir, markerPath } = hostSkillRoot();
		let stderr = "";

		const code = await launchSandboxedCli({
			command: "/bin/sh",
			args: ["-c", `printf tampered > ${markerPath}`],
			environment: {},
			workspace: cwd,
			skillPaths: { agentSkills: skillsDir },
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
		// The host's own copy is unaffected by the sandboxed child's rejected write.
		expect(readFileSync(markerPath, "utf8")).toBe("host-owned-skill-marker");
	});
});

// macOS's own denial text doesn't reliably distinguish filesystem from network
// refusals (see macos-backend.ts's classifySandboxFailure and
// cli-supervisor.test.ts's identical caveat), so this asserts "unknown", not
// "filesystem" -- the enforcement itself is what this test verifies.
describe.skipIf(!canEnforceMacosSandbox())("skill root mount under the real macOS sandbox", () => {
	it("reads a mounted skill file's real content at its original host path", async () => {
		const cwd = workspace("apex-sandbox-skill-mount-ws-");
		const { skillsDir, markerPath } = hostSkillRoot();
		const resultPath = join(cwd, "result.txt");

		const code = await launchSandboxedCli({
			command: "/bin/sh",
			args: ["-c", `cat ${markerPath} > ${resultPath}`],
			environment: {},
			workspace: cwd,
			skillPaths: { agentSkills: skillsDir },
			dependencies: {
				stderr: { write: () => true },
			},
		});

		expect(code).toBe(0);
		expect(readFileSync(resultPath, "utf8")).toBe("host-owned-skill-marker");
	});

	it("refuses a write into a mounted skill directory", async () => {
		const cwd = workspace("apex-sandbox-skill-mount-ws-");
		const { skillsDir, markerPath } = hostSkillRoot();
		let stderr = "";

		const code = await launchSandboxedCli({
			command: "/bin/sh",
			args: ["-c", `printf tampered > ${markerPath}`],
			environment: {},
			workspace: cwd,
			skillPaths: { agentSkills: skillsDir },
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
		expect(stderr).toContain("Sandbox violation (unknown)");
		expect(readFileSync(markerPath, "utf8")).toBe("host-owned-skill-marker");
	});
});
