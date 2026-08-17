/**
 * On Windows, npm is installed as npm.cmd. execFileSync/spawnSync cannot invoke
 * a .cmd file directly without shell interpretation -- confirmed on real
 * Windows CI: plain "npm" fails with ENOENT, and "npm.cmd" without a shell
 * fails with EINVAL (Node's own documented .bat/.cmd limitation for
 * child_process without `shell: true`). Matches scripts/local-release.mjs's
 * existing `shell: process.platform === "win32"` pattern, which lets the
 * shell itself resolve "npm" through PATH on every platform.
 *
 * `shell: true` does not itself quote array arguments containing spaces --
 * confirmed on real Windows CI against this repo's own required "spaced
 * checkout" (a path containing "apex code checkout"): an unquoted
 * `--workspace <path with a space>` argument was silently truncated at the
 * first space by cmd.exe's own tokenizing. npmSpawnArgs quotes any argument
 * containing whitespace before it reaches the shell; npmSpawnOptions is a
 * no-op combined with it on non-Windows platforms, where execFileSync/
 * spawnSync already handle argument boundaries correctly without a shell.
 */
export function npmSpawnArgs(args, platform = process.platform) {
	if (platform !== "win32") return args;
	return args.map((arg) => {
		if (!/[\s"]/.test(arg)) return arg;
		// Windows/CRT command-line quoting: double any run of backslashes that
		// immediately precedes the closing quote, then escape embedded quotes.
		const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
		return `"${escaped}"`;
	});
}

export function npmSpawnOptions(options = {}, platform = process.platform) {
	return { ...options, shell: platform === "win32" };
}
