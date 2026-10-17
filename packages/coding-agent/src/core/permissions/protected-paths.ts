/**
 * Paths the gate refuses to hand to a tool without an explicit decision.
 *
 * The agent directory's credential file is the only entry. It is the one file a session
 * can read that the harness itself wrote, it holds provider keys in cleartext, and its
 * 0600 mode protects it from other accounts rather than from this one. While the process
 * boundary existed the home directory was hidden and this file was deliberately mounted;
 * ADR 0032 removed the boundary and left the read-shaped tools at `allow`.
 *
 * This is not containment and does not pretend to be. A session can still run `cat` under
 * the `bash` tool, which asks. It closes the path that asked nothing.
 */

import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { getAuthPath } from "../../config.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";

/**
 * Why this path is protected, or undefined when it is ordinary.
 *
 * Compares through `realpathSync` on both sides, so a symlink to the credential file is
 * the credential file. Ancestors count because `grep`, `ls`, and `find` take a directory
 * and reach everything under it, so refusing only the exact file would leave the content
 * reachable by naming its parent. Only true ancestors of the credential file match, so an
 * ordinary workspace path is unaffected.
 */
export function describeProtectedTarget(path: string): string | undefined {
	const credentialPath = getAuthPath();
	const credential = canonicalizePath(resolvePath(credentialPath));
	const target = canonicalizePath(resolvePath(path));
	if (target === credential) return `${credentialPath} holds this session's provider credentials`;

	let ancestor = dirname(credential);
	while (true) {
		if (target === ancestor) return `${target} contains ${credentialPath}, which holds provider credentials`;
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	return homeCredentialMatch(target);
}

/**
 * Credential locations under the home directory (ADR 0032 removed the boundary that
 * hid them). Each is protected, and so is any directory that contains one, for the same
 * reason the agent's own credential file is.
 */
const HOME_CREDENTIAL_LOCATIONS = [
	".ssh",
	".aws",
	".gnupg",
	".config/gcloud",
	".kube",
	".docker/config.json",
	".netrc",
	".npmrc",
] as const;

function isWithin(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function homeCredentialMatch(target: string): string | undefined {
	const home = canonicalizePath(resolvePath(homedir()));
	for (const entry of HOME_CREDENTIAL_LOCATIONS) {
		const location = join(home, entry);
		if (isWithin(target, location)) return `${location} holds credentials`;
		if (isWithin(location, target)) return `${target} contains ${location}, which holds credentials`;
	}
	return undefined;
}

/** Template env files are documentation, not secrets. Everything else named `.env` or `.env.<suffix>` is sensitive. */
const ENV_TEMPLATE_NAMES = new Set([".env.example", ".env.sample", ".env.template"]);

/**
 * A file that commonly holds secrets inside a project. It asks by default wherever it sits,
 * and only a rule that names it can grant it (see PermissionSpec.allowRuleGrants).
 */
export function isSensitivePath(path: string): boolean {
	const name = basename(path);
	if (ENV_TEMPLATE_NAMES.has(name)) return false;
	return name === ".env" || name.startsWith(".env.");
}
