/**
 * Consumed ("frozen") packages under ADR 0001 -- everything under packages/ that
 * Apex Code does not fork. Forked packages (coding-agent, agent) are deliberately
 * absent: they are expected to diverge from upstream, and that divergence is what
 * ADR 0003 measures.
 *
 * Single source of truth shared by scripts/apex/check-frozen-packages.mjs (byte-identity
 * enforcement against the pinned upstream tag) and scripts/sync-versions.js (release
 * tooling must never write inside these directories -- ADR 0018).
 */
export const FROZEN_PACKAGE_DIRECTORIES = [
	"packages/ai",
	"packages/tui",
	"packages/client",
	"packages/protocol",
	"packages/server",
	"packages/telemetry",
];
