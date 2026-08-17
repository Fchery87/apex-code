/**
 * On Windows, npm is installed as `npm.cmd`, not `npm` -- `execFileSync`/`spawnSync`
 * without `shell: true` do not resolve the `.cmd` shim through PATH the way a real
 * shell does, and fail with ENOENT. Matches the existing `commandForPlatform`
 * pattern already used in scripts/publish.mjs and scripts/local-release.mjs.
 */
export function npmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}
