import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_PROVIDER_REQUESTS,
	DEFAULT_MAX_TOOL_CALLS,
	SettingsManager,
} from "../src/core/settings-manager.ts";

/**
 * Pins the default run-budget policy (TR.3/TR.5, spec
 * 2026-09-01-tool-reliability-and-execution-budgets.md). The selected values
 * come from docs/research/2026-09-02-run-budget-measurements.md; this test is
 * what stops them from drifting silently later.
 */

const directories: string[] = [];

function scratchPair(): { agentDir: string; projectDir: string } {
	const root = mkdtempSync(join(tmpdir(), "apex-run-budget-"));
	directories.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, ".apex-code"), { recursive: true });
	return { agentDir, projectDir };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function managerWith(settings: Record<string, unknown>): SettingsManager {
	const { agentDir, projectDir } = scratchPair();
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings), "utf-8");
	return SettingsManager.create(projectDir, agentDir);
}

describe("run budget settings", () => {
	it("resolves the measured default policy when nothing is configured", () => {
		const { agentDir, projectDir } = scratchPair();
		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getRunBudget()).toEqual({
			maxProviderRequests: DEFAULT_MAX_PROVIDER_REQUESTS,
			maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
			maxWallTimeMs: undefined,
		});
		expect(DEFAULT_MAX_PROVIDER_REQUESTS).toBe(200);
		expect(DEFAULT_MAX_TOOL_CALLS).toBe(2000);
	});

	it("resolves explicit per-field overrides", () => {
		const manager = managerWith({
			runBudget: { maxProviderRequests: 50, maxToolCalls: 400, maxWallTimeMs: 60000 },
		});

		expect(manager.getRunBudget()).toEqual({
			maxProviderRequests: 50,
			maxToolCalls: 400,
			maxWallTimeMs: 60000,
		});
	});

	it("resolves the explicit unlimited opt-out per field", () => {
		const manager = managerWith({
			runBudget: { maxProviderRequests: "unlimited", maxToolCalls: "unlimited", maxWallTimeMs: "unlimited" },
		});

		expect(manager.getRunBudget()).toEqual({
			maxProviderRequests: undefined,
			maxToolCalls: undefined,
			maxWallTimeMs: undefined,
		});
	});

	it("merges partial runBudget objects over the defaults", () => {
		const manager = managerWith({ runBudget: { maxProviderRequests: 30 } });

		expect(manager.getRunBudget()).toEqual({
			maxProviderRequests: 30,
			maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
			maxWallTimeMs: undefined,
		});
	});

	it("rejects invalid budget values at resolution time", () => {
		const manager = managerWith({ runBudget: { maxProviderRequests: -5 } });

		expect(() => manager.getRunBudget()).toThrow("Invalid runBudget.maxProviderRequests setting");
	});

	it("rejects non-numeric, non-unlimited budget values", () => {
		const manager = managerWith({ runBudget: { maxToolCalls: true } });

		expect(() => manager.getRunBudget()).toThrow("Invalid runBudget.maxToolCalls setting");
	});
});
