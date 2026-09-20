import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";

/**
 * The single list of project-controlled resources a repository can supply, and the only
 * place their paths are built.
 *
 * Both halves of the trust boundary resolve through here: the loaders ask for a path,
 * and `hasTrustRequiringProjectResources` asks the same question of the same entries.
 * Before this existed the two were independent, and four resources were read without
 * ever reaching the classifier (`permissions.json`, `permissions.local.json`, `agents/`,
 * and `.mcp.json`), so a cloned repository supplying one of them was classified trusted
 * and the guard that drops untrusted scopes was satisfied rather than triggered.
 *
 * Relocating the list is not enough on its own. A loader that builds `join(cwd,
 * ".apex-code", …)` by hand diverges the moment `CONFIG_DIR_NAME` is overridden, which
 * reintroduces the same bypass with no test failing, so the path builders below are the
 * supported way to reach a project resource. See
 * `docs/specs/2026-09-11-trust-classification-and-proof-integrity.md`.
 */

/**
 * Where an entry's `name` is resolved from.
 *
 * `config-dir` resolves under `<cwd>/<CONFIG_DIR_NAME>`. `root` resolves at `<cwd>`,
 * which is what lets `.mcp.json` reach the classifier at all.
 *
 * The ancestor `.agents/skills` walk is deliberately not a scope here. It has no fixed
 * depth and one path under the user's home is exempt, so it lives in the classifier
 * rather than as an entry a caller could resolve to a single path. Adding an `ancestor`
 * member without implementing the walk would let an entry silently resolve at `cwd`
 * only, which is the narrowing this registry exists to prevent.
 */
export type ProjectResourceScope = "config-dir" | "root";

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
	/** Path relative to the entry's scope root. A single path segment. */
	readonly name: string;
	readonly scope: ProjectResourceScope;
	readonly authority: ProjectResourceAuthority;
}

export const PROJECT_PERMISSIONS_FILE = "permissions.json";
export const PROJECT_LOCAL_PERMISSIONS_FILE = "permissions.local.json";
export const PROJECT_AGENTS_DIR = "agents";
export const PROJECT_MCP_CONFIG_FILE = ".mcp.json";

/**
 * The repository instruction files, in the order the loader prefers them.
 *
 * These are wrapped as `<project_instructions>` and handed to the model as instructions,
 * so a checkout supplying one is steering the agent. That is what the trust prompt asks
 * about, and until this list was registered they reached the system prompt through no gate.
 *
 * The loader reads this array rather than its own copy. A sixth spelling added to one and
 * not the other is the exact divergence this registry exists to prevent, and the earlier
 * form of that bug is why the registry exists at all.
 */
export const PROJECT_INSTRUCTION_FILES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
] as const;

export const PROJECT_RESOURCES: readonly ProjectResource[] = [
	{ name: "settings.json", scope: "config-dir", authority: "presence" },
	{ name: "extensions", scope: "config-dir", authority: "presence" },
	{ name: "skills", scope: "config-dir", authority: "presence" },
	{ name: "prompts", scope: "config-dir", authority: "presence" },
	{ name: "themes", scope: "config-dir", authority: "presence" },
	{ name: "SYSTEM.md", scope: "config-dir", authority: "presence" },
	{ name: "APPEND_SYSTEM.md", scope: "config-dir", authority: "presence" },
	{ name: PROJECT_PERMISSIONS_FILE, scope: "config-dir", authority: "permission-scope" },
	{ name: PROJECT_LOCAL_PERMISSIONS_FILE, scope: "config-dir", authority: "permission-scope" },
	{ name: PROJECT_AGENTS_DIR, scope: "config-dir", authority: "presence" },
	{ name: PROJECT_MCP_CONFIG_FILE, scope: "root", authority: "presence" },
	...PROJECT_INSTRUCTION_FILES.map(
		(name) => ({ name, scope: "root", authority: "presence" }) as const satisfies ProjectResource,
	),
] as const;

/** The project config directory for `cwd`. Honors a `piConfig.configDir` override. */
export function projectConfigDir(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME);
}

/**
 * Absolute path of one project resource. Loaders call this instead of composing the
 * config directory themselves, so a loader cannot read a path the classifier does not
 * check.
 */
export function projectResourcePath(cwd: string, resource: ProjectResource): string {
	return join(resource.scope === "config-dir" ? projectConfigDir(cwd) : cwd, resource.name);
}

export function projectResource(name: string): ProjectResource {
	const resource = PROJECT_RESOURCES.find((candidate) => candidate.name === name);
	if (!resource) throw new Error(`Unknown project resource: ${name}`);
	return resource;
}

/** Convenience for the common case: a resource addressed by name. */
export function projectResourcePathByName(cwd: string, name: string): string {
	return projectResourcePath(cwd, projectResource(name));
}
