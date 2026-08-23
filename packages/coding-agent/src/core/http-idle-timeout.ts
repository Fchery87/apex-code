/**
 * The idle-timeout setting's default and parser, isolated from `http-dispatcher.ts` on
 * purpose: the dispatcher module loads `undici`, and `settings-manager` -- which every
 * supervisor launch imports to resolve the network allowlist before the child exists
 * (see `scripts/measure-supervisor-imports.mjs`) -- only needs these two definitions.
 * Keeping them here means parsing a settings file never pays for an HTTP stack, while
 * the dispatcher remains the single place that consumes the timeout.
 */

/** Five minutes; Node's own default (no timeout) leaves stale pools open for hours. */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}
