/**
 * The single list of project-controlled resources a repository can supply.
 *
 * Both halves of the trust boundary read this list: the loaders resolve their paths
 * from it, and `hasTrustRequiringProjectResources` decides from it whether a project
 * needs an explicit trust decision. Before this existed the two were separate, and a
 * resource could be read without ever reaching the classifier. Four of them were
 * (`permissions.json`, `permissions.local.json`, `agents/`, and `.mcp.json`), which
 * meant a cloned repository supplying only one of those was classified trusted and
 * the guard that drops untrusted scopes was satisfied rather than triggered. See
 * `docs/specs/2026-09-11-trust-classification-and-proof-integrity.md`.
 *
 * Adding a loader means adding an entry here, and the classifier picks it up in the
 * same commit.
 */

/**
 * Where an entry's `name` is resolved from.
 *
 * `config-dir` resolves under `<cwd>/<CONFIG_DIR_NAME>`. `root` resolves at `<cwd>`,
 * which is what lets `.mcp.json` reach the classifier at all. `ancestor` walks upward
 * from `<cwd>`, which is how a skills directory in a parent repository is found while
 * the user's own `~/.agents/skills` stays excluded.
 */
export type ProjectResourceScope = "config-dir" | "root" | "ancestor";

/**
 * How presence maps to authority.
 *
 * `presence` means existing is enough. `permission-scope` means the file is parsed and
 * only grants authority when it carries a rule or a mode, because a `{}` permissions
 * file confers nothing and this repository ships one. A prompt carrying no decision
 * teaches people to dismiss prompts.
 */
export type ProjectResourceAuthority = "presence" | "permission-scope";

export interface ProjectResource {
	/** Path relative to the entry's scope root. */
	readonly name: string;
	readonly scope: ProjectResourceScope;
	readonly authority: ProjectResourceAuthority;
}

export const PROJECT_RESOURCES: readonly ProjectResource[] = [
	{ name: "settings.json", scope: "config-dir", authority: "presence" },
	{ name: "extensions", scope: "config-dir", authority: "presence" },
	{ name: "skills", scope: "config-dir", authority: "presence" },
	{ name: "prompts", scope: "config-dir", authority: "presence" },
	{ name: "themes", scope: "config-dir", authority: "presence" },
	{ name: "SYSTEM.md", scope: "config-dir", authority: "presence" },
	{ name: "APPEND_SYSTEM.md", scope: "config-dir", authority: "presence" },
	{ name: "permissions.json", scope: "config-dir", authority: "permission-scope" },
	{ name: "permissions.local.json", scope: "config-dir", authority: "permission-scope" },
	{ name: "agents", scope: "config-dir", authority: "presence" },
	{ name: ".mcp.json", scope: "root", authority: "presence" },
] as const;

/**
 * Resolved separately from `PROJECT_RESOURCES` because the walk has no fixed depth and
 * one path under the user's home is deliberately exempt. The classifier owns both
 * facts; callers that only need the set of gated names should read the array above.
 */
export const ANCESTOR_PROJECT_RESOURCE = ".agents/skills" as const;

export function projectResourceNames(scope: ProjectResourceScope): readonly string[] {
	return PROJECT_RESOURCES.filter((resource) => resource.scope === scope).map((resource) => resource.name);
}
