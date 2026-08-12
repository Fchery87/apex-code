/**
 * Startup-time permission mode resolution (ADR 0004). A misconfigured
 * non-interactive run should fail fast, at startup, with an actionable message —
 * not deny every tool call mid-run in a way that looks like a bug (see the ADR's
 * "ask fails closed, and a session that cannot ask refuses to start").
 */

import { PERMISSION_MODES, type PermissionMode, type WritablePermissionSource } from "./store.ts";

export type PermissionModeStartupResult = { ok: true; mode: PermissionMode } | { ok: false; message: string };

/**
 * `requestedMode` is assumed already validated against `PERMISSION_MODES` (args.ts
 * rejects an unknown value at parse time) — this only decides whether a session may
 * start *without* one. Interactive sessions may: an `ask` there has a human to
 * resolve it. Non-interactive sessions may not: with no responder, `ask` fails
 * closed to `deny`, and discovering that per-call, mid-run, is the exact bad
 * failure mode this check exists to avoid.
 */
export function resolvePermissionModeForStartup(options: {
	interactive: boolean;
	requestedMode: PermissionMode | undefined;
}): PermissionModeStartupResult {
	if (options.requestedMode !== undefined) {
		return { ok: true, mode: options.requestedMode };
	}
	if (!options.interactive) {
		return {
			ok: false,
			message: `Non-interactive sessions require an explicit --permission-mode. Valid modes: ${PERMISSION_MODES.join(", ")}.`,
		};
	}
	return { ok: true, mode: "default" };
}

/** Sources a mode can come from, in precedence order — mirrors PERMISSION_SOURCES (rules.ts), restricted to the sources that can plausibly set one. */
const MODE_SOURCE_ORDER: readonly ["flag", ...WritablePermissionSource[]] = [
	"flag",
	"local",
	"project",
	"user",
	"command",
	"session",
];

/**
 * The `--permission-mode` flag outranks every persisted mode, including a project
 * rule a team committed — a deliberate per-run operator decision should not be
 * silently overridden by checked-in config (ADR 0004).
 */
export function resolveEffectiveMode(
	flagMode: PermissionMode | undefined,
	modesBySource: ReadonlyMap<WritablePermissionSource, PermissionMode>,
): PermissionMode {
	for (const source of MODE_SOURCE_ORDER) {
		if (source === "flag") {
			if (flagMode !== undefined) return flagMode;
			continue;
		}
		const mode = modesBySource.get(source);
		if (mode !== undefined) return mode;
	}
	return "default";
}
