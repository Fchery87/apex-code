import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "../src/core/settings-diagnostics.ts";
import { SettingsManager, type SettingsStorage } from "../src/core/settings-manager.ts";

describe("settings diagnostics", () => {
	it("includes the settings file path for file-backed storage", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-settings-diagnostics-"));
		const agentDir = join(tempDir, "agent");
		const settingsPath = join(agentDir, "settings.json");
		mkdirSync(agentDir);
		writeFileSync(settingsPath, "{");

		try {
			const diagnostics = collectSettingsDiagnostics(SettingsManager.create(tempDir, agentDir));

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.type).toBe("warning");
			expect(diagnostics[0]?.message).toContain(`Invalid settings file ${settingsPath}:`);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to the settings scope for storage without file paths", () => {
		const storage: SettingsStorage = {
			withLock(scope, fn) {
				if (scope === "global") throw new Error("backend failed");
				fn(undefined);
			},
		};
		const diagnostics = collectSettingsDiagnostics(SettingsManager.fromStorage(storage));

		expect(diagnostics).toEqual([{ type: "warning", message: "Invalid global settings: backend failed" }]);
	});

	it("deduplicates diagnostics by type and message", () => {
		const warning = { type: "warning" as const, message: "Invalid settings file /tmp/settings.json" };

		expect(deduplicateDiagnostics([warning, warning, { ...warning, type: "error" }])).toEqual([
			warning,
			{ ...warning, type: "error" },
		]);
	});
});

/**
 * ADR 0032 removed the OS boundary and with it `network.allowedHosts`,
 * `network.allowDefaultHosts`, and `sandboxProfiles`. Nothing reads those keys now.
 * The removed CLI flags fail loudly (`cli/args.ts` collects an unknown flag and
 * `main.ts` exits non-zero), but a settings file keeps parsing, so an upgrader who
 * restricted egress in 0.0.6 silently loses the restriction. The changelog claims the
 * two removals are equivalent. They are not, unless the settings path says something.
 */
describe("removed sandbox settings", () => {
	function diagnosticsFor(scope: "global" | "project", settings: Record<string, unknown>): string[] {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-removed-sandbox-settings-"));
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const path = scope === "global" ? join(agentDir, "settings.json") : join(tempDir, ".apex-code", "settings.json");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify(settings));
		try {
			return collectSettingsDiagnostics(SettingsManager.create(tempDir, agentDir)).map(
				(diagnostic) => diagnostic.message,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	}

	it("warns that a configured egress allowlist no longer restricts anything", () => {
		const messages = diagnosticsFor("global", { network: { allowedHosts: ["api.example.com"] } });

		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("network.allowedHosts");
		expect(messages[0]).toContain("no longer");
	});

	it("warns for every removed key, in either scope", () => {
		expect(diagnosticsFor("global", { network: { allowDefaultHosts: false } })[0]).toContain(
			"network.allowDefaultHosts",
		);
		expect(diagnosticsFor("project", { sandboxProfiles: { strict: {} } })[0]).toContain("sandboxProfiles");
	});

	it("names every removed key it found, so one warning covers the whole file", () => {
		const messages = diagnosticsFor("global", {
			network: { allowedHosts: ["a"], allowDefaultHosts: true },
			sandboxProfiles: {},
		});

		expect(messages).toHaveLength(1);
		for (const key of ["network.allowedHosts", "network.allowDefaultHosts", "sandboxProfiles"]) {
			expect(messages[0]).toContain(key);
		}
	});

	it("stays silent for a settings file that carries none of them", () => {
		expect(diagnosticsFor("global", { theme: "ember", network: {} })).toEqual([]);
	});
});
