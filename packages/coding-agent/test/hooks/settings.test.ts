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
	const root = mkdtempSync(join(tmpdir(), "apex-hook-settings-"));
	directories.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".apex-code"), { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(global));
	return SettingsManager.create(projectDir, agentDir);
}

describe("hook settings", () => {
	it("is absent by default, so an unconfigured session constructs no runtime", () => {
		expect(settingsManager({}).getHookSettings()).toBeUndefined();
	});

	it("reads configured handlers per event", () => {
		const settings = settingsManager({
			hooks: { tool_call: [{ type: "command", command: "echo", matcher: "bash|powershell" }] },
		}).getHookSettings();

		expect(settings?.tool_call).toEqual([{ type: "command", command: "echo", matcher: "bash|powershell" }]);
	});

	it("hands back a copy rather than the live settings object", () => {
		const manager = settingsManager({ hooks: { turn_end: [{ type: "command", command: "notify" }] } });
		const first = manager.getHookSettings();
		(first as { turn_end?: unknown[] }).turn_end = undefined;

		expect(manager.getHookSettings()?.turn_end).toHaveLength(1);
	});
});
