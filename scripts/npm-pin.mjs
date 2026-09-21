/**
 * The npm version this repository expects, and the comparison the pre-commit
 * lockfile guard uses.
 *
 * npm 10 and npm 11 do not produce interchangeable lockfiles. npm 11 can write a
 * `package-lock.json` that npm 10 refuses to install from at all, failing with
 * `Cannot read properties of null (reading 'edgesOut')`, and the two resolve root
 * `overrides` differently for a workspace's own direct dependency (ADR 0036). CI
 * runs the Node version `engines` declares as the floor, so a lockfile generated
 * on a newer npm can pass locally and break every CI job.
 *
 * The pin lives in `package.json` as the standard `packageManager` field, so
 * corepack honors it where it is enabled. npm does not enforce the field itself,
 * which is why the pre-commit guard checks it when a lockfile is staged.
 */

/** Read the pinned npm version from a parsed `package.json`, if it pins npm. */
export function readNpmPin(manifest) {
	const declared = manifest?.packageManager;
	if (typeof declared !== "string") return undefined;
	const match = /^npm@(\d+\.\d+\.\d+)$/.exec(declared.trim());
	return match?.[1];
}

/** Pull the npm version out of an `npm_config_user_agent` string. */
export function npmVersionFromUserAgent(userAgent) {
	if (typeof userAgent !== "string") return undefined;
	const match = /(?:^|\s)npm\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(userAgent);
	return match?.[1];
}

/**
 * Describe a mismatch worth blocking on, or `undefined` when there is none.
 *
 * Only the major is compared. A patch difference does not change lockfile
 * compatibility, and failing on one would make the guard noise. An npm version we
 * could not detect is not a mismatch either: the guard exists to catch a known-bad
 * combination, not to demand proof of a good one.
 */
export function describeNpmMismatch(pinned, actual) {
	if (!pinned || !actual) return undefined;
	const pinnedMajor = pinned.split(".")[0];
	const actualMajor = actual.split(".")[0];
	if (pinnedMajor === actualMajor) return undefined;
	return (
		// State only what is known. This sees the npm running the commit, not the npm that
		// wrote the lockfile, and those differ whenever someone regenerates under one version
		// and commits under another -- which is a thing to warn about, not to assert happened.
		`You are committing a lockfile change from npm ${actual}, but this repository pins npm ${pinned}.\n` +
		"\n" +
		`npm ${actualMajor} and npm ${pinnedMajor} do not produce interchangeable lockfiles: a lockfile\n` +
		"written by the newer one can fail to install on the older with\n" +
		"  npm error Cannot read properties of null (reading 'edgesOut')\n" +
		"and CI runs the older one. A lockfile committed from here can pass every local\n" +
		"check and still break every CI job. See ADR 0036.\n" +
		"\n" +
		`Generate the lockfile and commit it from npm ${pinnedMajor}, for example:\n` +
		"  nvm use 22 && rm -rf node_modules && npm install && git commit ...\n" +
		"\n" +
		"If you have a reason to commit this lockfile anyway, set:\n" +
		"  PI_ALLOW_NPM_VERSION_MISMATCH=1"
	);
}
