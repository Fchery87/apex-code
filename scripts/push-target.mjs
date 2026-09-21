/**
 * Refuse a direct push to `main`.
 *
 * `main` is protected on the remote and carries four required status checks, but branch
 * protection is enforced against most people and bypassed by a maintainer's own privilege.
 * The bypass therefore travels with the person, not the repository: a plain `git push` run
 * from a `main` checkout lands substantive commits with none of the three-OS evidence a pull
 * request would have required, and GitHub reports it only afterwards, in the push output that
 * nobody reads on success.
 *
 * That is not hypothetical. `11795689a..27066ad8a` reached `main` exactly this way, because a
 * branch was created and never checked out. See `docs/release-governance-checklist.md`.
 *
 * Tags are untouched: a release pushes one, and a tag cannot carry unreviewed source into a
 * protected branch. The release script pushes `main` on purpose and says so with
 * PI_ALLOW_MAIN_PUSH.
 */

const PROTECTED_BRANCHES = new Set(["refs/heads/main"]);

/**
 * Describe a push that should be refused, or `undefined` to let it through.
 *
 * `stdin` is git's pre-push payload: one `<local ref> <local oid> <remote ref> <remote oid>`
 * line per ref. A line that does not parse is ignored rather than treated as a violation --
 * this hook exists to stop a specific mistake, and a guard that blocks pushes it does not
 * understand would be turned off.
 */
export function describeProtectedPush(stdin, env = process.env) {
	if (["1", "true", "yes"].includes(env.PI_ALLOW_MAIN_PUSH ?? "")) return undefined;

	const targets = new Set();
	for (const line of String(stdin ?? "").split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields.length !== 4) continue;
		const remoteRef = fields[2];
		if (PROTECTED_BRANCHES.has(remoteRef)) targets.add(remoteRef);
	}
	if (targets.size === 0) return undefined;

	const names = [...targets].map((ref) => ref.replace("refs/heads/", "")).join(", ");
	return (
		`Refusing to push directly to ${names}.\n` +
		"\n" +
		"main is protected and requires four status checks, but a maintainer's own bypass\n" +
		"privilege lets a direct push through anyway -- landing commits that no CI job has\n" +
		"seen on any platform. That has happened here once already (11795689a..27066ad8a),\n" +
		"because a branch was created and never checked out.\n" +
		"\n" +
		"Push a branch and open a pull request:\n" +
		"  git switch -c <branch>\n" +
		"  git push -u origin <branch>\n" +
		"\n" +
		"Releases push main deliberately; scripts/release.mjs sets PI_ALLOW_MAIN_PUSH=1.\n" +
		"If you are doing that by hand and mean it, set it yourself."
	);
}
