import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(userSettings: unknown, projectSettings: unknown) {
	const root = mkdtempSync(join(tmpdir(), "apex-wf-settings-"));
	dirs.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".apex-code"), { recursive: true });
	if (userSettings !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(userSettings));
	if (projectSettings !== undefined) {
		writeFileSync(join(projectDir, ".apex-code", "settings.json"), JSON.stringify(projectSettings));
	}
	return SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
}

describe("webFetch.allowPrivateNetwork setting (HR.4)", () => {
	it("is off when unset", () => {
		expect(setup(undefined, undefined).getWebFetchAllowPrivateNetwork()).toBe(false);
	});

	it("is on when the user sets it", () => {
		expect(setup({ webFetch: { allowPrivateNetwork: true } }, undefined).getWebFetchAllowPrivateNetwork()).toBe(true);
	});

	it("ignores a project that sets it, even in a trusted project", () => {
		const manager = setup(undefined, { webFetch: { allowPrivateNetwork: true } });
		expect(manager.getWebFetchAllowPrivateNetwork()).toBe(false);
	});
});

describe("webFetch.allowProxiedFetch setting (Q4)", () => {
	it("is off when unset, on when the user sets it, and ignored in a project", () => {
		expect(setup(undefined, undefined).getWebFetchAllowProxiedFetch()).toBe(false);
		expect(setup({ webFetch: { allowProxiedFetch: true } }, undefined).getWebFetchAllowProxiedFetch()).toBe(true);
		expect(setup(undefined, { webFetch: { allowProxiedFetch: true } }).getWebFetchAllowProxiedFetch()).toBe(false);
	});
});

describe("mcpStartupDiscovery setting (Q7)", () => {
	it("is on by default and off when the user sets it", () => {
		expect(setup(undefined, undefined).getMcpStartupDiscovery()).toBe(true);
		expect(setup({ mcpStartupDiscovery: false }, undefined).getMcpStartupDiscovery()).toBe(false);
	});
});
