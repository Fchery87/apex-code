/**
 * Models trained on other harnesses name a path several ways. Apex schemas
 * document one name, `path`. Validation runs before a renderer, so a call that
 * only sets `file_path` fails even though the renderer would have understood it.
 *
 * Copy the first alias into `path` when `path` is absent. A call that sets
 * `path` keeps it, and the alias stays in the object. These schemas allow
 * extra properties, so the leftover name does not fail validation.
 */
const PATH_ALIASES = ["file_path", "filePath", "filepath", "directory", "dir"] as const;

export function acceptFilePathAlias(input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	const args = input as Record<string, unknown>;
	if (typeof args.path === "string") return input;
	const alias = PATH_ALIASES.find((name) => typeof args[name] === "string");
	return alias ? { ...args, path: args[alias] } : input;
}
