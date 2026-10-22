/**
 * Models trained on other harnesses send `file_path` where Apex schemas say `path`.
 * The renderers already read both names, but validation runs first and rejects the
 * call before a renderer sees it. Fold the alias in here, and only when `path` is
 * absent, so a call that sets both keeps the name the schema documents.
 */
export function acceptFilePathAlias(input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	const args = input as Record<string, unknown>;
	if (typeof args.path === "string" || typeof args.file_path !== "string") return input;
	const { file_path, ...rest } = args;
	return { ...rest, path: file_path };
}
