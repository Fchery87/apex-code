import type { AgentSessionRuntimeDiagnostic } from "./agent-session-services.ts";
import { findRemovedSettings, removedSettingsMessage } from "./removed-settings.ts";
import type { SettingsManager, SettingsScope } from "./settings-manager.ts";

export function collectSettingsDiagnostics(settingsManager: SettingsManager): AgentSessionRuntimeDiagnostic[] {
	const diagnostics: AgentSessionRuntimeDiagnostic[] = settingsManager.drainErrors().map(({ scope, path, error }) => ({
		type: "warning",
		message: path ? `Invalid settings file ${path}: ${error.message}` : `Invalid ${scope} settings: ${error.message}`,
	}));

	const scopes: ReadonlyArray<[SettingsScope, object]> = [
		["global", settingsManager.getGlobalSettings()],
		["project", settingsManager.getProjectSettings()],
	];
	for (const [scope, settings] of scopes) {
		const names = findRemovedSettings(settings);
		if (names.length === 0) continue;
		diagnostics.push({
			type: "warning",
			message: removedSettingsMessage(scope, settingsManager.getSettingsPath(scope), names),
		});
	}

	return diagnostics;
}

/**
 * Remove duplicate type/message diagnostics while preserving their first occurrence.
 * Startup and runtime settings managers can report the same file error.
 */
export function deduplicateDiagnostics(
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): AgentSessionRuntimeDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.type}\0${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
