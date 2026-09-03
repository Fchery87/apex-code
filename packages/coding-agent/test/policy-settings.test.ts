import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type PoliciesSettings, SettingsManager } from "../src/core/settings-manager.ts";

/**
 * VF.1 (spec 2026-09-01-configured-verification-and-formatting.md § 1,
 * ADR 0028): settings-layer ownership, precedence, and trust for named
 * verification and formatter policies. This layer only owns and exposes the
 * raw per-source settings; strict validation and the runtime resolver land
 * with the policy loader (VF.2). Nothing here executes a command — an
 * absent `policies` key constructs no runtime and changes no behavior.
 */

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratchPair(): { agentDir: string; projectDir: string } {
	const root = mkdtempSync(join(tmpdir(), "apex-policy-settings-"));
	directories.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".apex-code"), { recursive: true });
	return { agentDir, projectDir };
}

function writeGlobal(agentDir: string, settings: unknown): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings), "utf-8");
}

function writeProject(projectDir: string, settings: unknown): void {
	writeFileSync(join(projectDir, ".apex-code", "settings.json"), JSON.stringify(settings), "utf-8");
}

const userVerification = [
	{
		id: "typecheck",
		executable: "npx",
		argv: ["tsc", "--noEmit"],
		timeoutMs: 120000,
		maxOutputBytes: 262144,
		maxOutputLines: 2000,
		permission: "ask",
		blocksCompletion: true,
	},
];

const projectFormatter = [
	{
		id: "format",
		executable: "npx",
		argv: ["biome", "format", "--write"],
		declaredPaths: ["src/**/*.ts"],
		timeoutMs: 30000,
		maxOutputBytes: 65536,
		maxOutputLines: 500,
		permission: "allow",
	},
];

describe("policy settings ownership, precedence, and trust", () => {
	it("is inert when no policies key exists anywhere", () => {
		const { agentDir, projectDir } = scratchPair();
		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getGlobalSettings().policies).toBeUndefined();
		expect(manager.getProjectSettings().policies).toBeUndefined();
		expect(manager.getPolicySettings()).toBeUndefined();
		expect(manager.drainErrors()).toEqual([]);
	});

	it("exposes user-level policies untouched", () => {
		const { agentDir, projectDir } = scratchPair();
		writeGlobal(agentDir, { policies: { schemaVersion: 1, verification: userVerification } });
		const manager = SettingsManager.create(projectDir, agentDir);

		const policies: PoliciesSettings | undefined = manager.getGlobalSettings().policies;
		expect(policies?.schemaVersion).toBe(1);
		expect(policies?.verification?.[0]?.id).toBe("typecheck");
		expect(policies?.verification?.[0]?.blocksCompletion).toBe(true);
		expect(manager.getPolicySettings()?.verification?.[0]?.executable).toBe("npx");
	});

	it("exposes trusted project policies and lets project arrays replace user arrays at this raw layer", () => {
		const { agentDir, projectDir } = scratchPair();
		writeGlobal(agentDir, { policies: { schemaVersion: 1, verification: userVerification } });
		writeProject(projectDir, { policies: { schemaVersion: 1, formatter: projectFormatter } });
		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.isProjectTrusted()).toBe(true);
		expect(manager.getProjectSettings().policies?.formatter?.[0]?.declaredPaths).toEqual(["src/**/*.ts"]);
		// Raw-layer merge is per key: the project's formatter array is added
		// while the user's verification array survives untouched. When both
		// sides define the SAME array key, the project array replaces the
		// user array wholesale — which is why the VF.2 resolver consumes
		// getGlobalSettings()/getProjectSettings() separately and resolves
		// per policy ID instead of trusting the merged view.
		expect(manager.getPolicySettings()?.verification).toEqual(userVerification);
		expect(manager.getPolicySettings()?.formatter).toEqual(projectFormatter);
	});

	it("never loads project policies when the project is not trusted", () => {
		const { agentDir, projectDir } = scratchPair();
		writeGlobal(agentDir, { policies: { schemaVersion: 1, verification: userVerification } });
		writeProject(projectDir, { policies: { schemaVersion: 1, formatter: projectFormatter } });
		const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

		expect(manager.isProjectTrusted()).toBe(false);
		expect(manager.getProjectSettings().policies).toBeUndefined();
		expect(manager.getPolicySettings()?.verification?.[0]?.id).toBe("typecheck");
		expect(manager.getPolicySettings()?.formatter).toBeUndefined();
	});

	it("surfacing a malformed settings file keeps policies inert and drains a scoped error", () => {
		const { agentDir, projectDir } = scratchPair();
		writeFileSync(join(agentDir, "settings.json"), "{ not json", "utf-8");
		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getGlobalSettings().policies).toBeUndefined();
		const errors = manager.drainErrors();
		expect(errors.length).toBe(1);
		expect(errors[0].scope).toBe("global");
	});

	it("keeps policy data intact through a settings round-trip on disk", () => {
		const { agentDir, projectDir } = scratchPair();
		writeGlobal(agentDir, {
			policies: {
				schemaVersion: 1,
				verification: userVerification,
				formatter: projectFormatter,
			},
		});
		SettingsManager.create(projectDir, agentDir);

		const onDisk = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")) as {
			policies?: PoliciesSettings;
		};
		expect(onDisk.policies?.verification?.[0]?.argv).toEqual(["tsc", "--noEmit"]);
		expect(onDisk.policies?.formatter?.[0]?.declaredPaths).toEqual(["src/**/*.ts"]);
	});
});
