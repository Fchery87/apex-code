/**
 * Settings keys that ADR 0032 removed along with the process boundary.
 *
 * The removed CLI flags fail loudly: `cli/args.ts` collects an unrecognized flag and
 * `main.ts` exits non-zero before a session starts. A settings file has no equivalent,
 * because the loader ignores keys it does not know and keeps going. So an operator who
 * restricted egress in 0.0.6 upgrades, keeps their file, and loses the restriction with
 * nothing said. The changelog presents the two removals as equivalent. They are not
 * unless this path speaks.
 *
 * These names live in one module because a deprecation notice has to name what it
 * deprecates, and `scripts/apex/no-os-sandbox-surface.test.mjs` otherwise forbids these
 * identifiers anywhere in `src`. That guard grants this file a narrow exemption.
 */

import type { SettingsScope } from "./settings-manager.ts";

interface RemovedSetting {
	/** Where the key sits in a settings object. */
	readonly path: readonly string[];
	/** How the key is written in a settings file, for the message. */
	readonly name: string;
}

export const REMOVED_SETTINGS: readonly RemovedSetting[] = [
	{ path: ["network", "allowedHosts"], name: "network.allowedHosts" },
	{ path: ["network", "allowDefaultHosts"], name: "network.allowDefaultHosts" },
	{ path: ["sandboxProfiles"], name: "sandboxProfiles" },
];

/** True when the key is present at all. A key set to `false` or `[]` was still configured. */
function isPresent(settings: object, path: readonly string[]): boolean {
	let current: unknown = settings;
	for (const segment of path) {
		if (typeof current !== "object" || current === null) return false;
		current = (current as Record<string, unknown>)[segment];
	}
	return current !== undefined;
}

export function findRemovedSettings(settings: object): string[] {
	return REMOVED_SETTINGS.filter((setting) => isPresent(settings, setting.path)).map((setting) => setting.name);
}

export function removedSettingsMessage(
	scope: SettingsScope,
	path: string | undefined,
	names: readonly string[],
): string {
	const where = scope === "global" ? "Global settings" : "Project settings";
	const location = path ? ` (${path})` : "";
	const keys = names.join(", ");
	const verb = names.length === 1 ? "it no longer restricts" : "they no longer restrict";
	return `${where}${location} still set ${keys}. Apex Code provides no isolation of its own (ADR 0032), so ${verb} anything. Delete the keys.`;
}
