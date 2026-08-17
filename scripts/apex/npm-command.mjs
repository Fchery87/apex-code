/**
 * On Windows, npm is installed as npm.cmd. execFileSync/spawnSync cannot invoke
 * a .cmd file directly without shell interpretation -- confirmed on real
 * Windows CI: plain "npm" fails with ENOENT, and "npm.cmd" without a shell
 * fails with EINVAL (Node's own documented .bat/.cmd limitation for
 * child_process without `shell: true`). Matches scripts/local-release.mjs's
 * existing `shell: process.platform === "win32"` pattern, which lets the
 * shell itself resolve "npm" through PATH on every platform.
 */
export function npmSpawnOptions(options = {}) {
	return { ...options, shell: process.platform === "win32" };
}
