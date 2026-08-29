import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

/** A project and agent directory pair carrying exactly the global settings under test. */
function settingsManager(global: Record<string, unknown>): SettingsManager {
	const root = mkdtempSync(join(tmpdir(), "apex-checkpoint-settings-"));
	directories.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".apex-code"), { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global));
	return SettingsManager.create(projectDir, agentDir);
}

describe("checkpoint settings", () => {
	it("is absent by default, so an unconfigured session constructs no engine", () => {
		expect(settingsManager({}).getCheckpointSettings()).toBeUndefined();
	});

	it("reads enabled and maxPerSession", () => {
		const settings = settingsManager({ checkpoints: { enabled: true, maxPerSession: 10 } }).getCheckpointSettings();

		expect(settings).toEqual({ enabled: true, maxPerSession: 10 });
	});

	it("hands back a copy rather than the live settings object", () => {
		const manager = settingsManager({ checkpoints: { enabled: true } });
		const first = manager.getCheckpointSettings();
		(first as { enabled?: boolean }).enabled = false;

		expect(manager.getCheckpointSettings()?.enabled).toBe(true);
	});
});
