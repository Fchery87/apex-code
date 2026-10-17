/**
 * Commands that run without a prompt in default mode (HR.21). Every command here reads only
 * the repository or prints a version, so an allow cannot reach a file outside the workspace or
 * change anything. The list is closed on purpose: a forgotten flag costs one prompt, never a hole.
 */

const VERSION_TOOLS = new Set(["git", "node", "npm", "rg", "python3"]);

const GIT_FLAGS: Record<string, ReadonlySet<string>> = {
	status: new Set(["-s", "-b", "--short", "--branch", "--porcelain"]),
	log: new Set(["--oneline", "--stat", "--graph", "--decorate", "--all", "-p"]),
	diff: new Set(["--stat", "--name-only", "--name-status", "--cached", "--staged"]),
	show: new Set(["--stat", "--oneline", "--name-only", "--no-patch", "-s"]),
	branch: new Set(["-a", "-r", "-v", "-vv", "--all", "--remotes", "--list", "--show-current"]),
	"rev-parse": new Set(["--abbrev-ref", "--show-toplevel", "--short", "--git-dir"]),
};

/** A ref name or revision: no option form, no absolute or parent path, no pathspec separator. */
function isRefLike(token: string): boolean {
	if (token.startsWith("-") || token.includes("--")) return false;
	if (token.startsWith("/") || token.startsWith("./") || token.startsWith("../")) return false;
	if (token.includes("/../")) return false;
	return /^[A-Za-z0-9._~^@/:+-]+$/.test(token);
}

/** A pathspec inside the repository: relative, with no escape out of it. */
function isInRepoPath(token: string): boolean {
	return isRefLike(token) || (!token.startsWith("-") && !token.startsWith("/") && !token.split("/").includes(".."));
}

function isReadOnlyGit(tokens: readonly string[]): boolean {
	const [subcommand, ...rest] = tokens;
	const flags = subcommand ? GIT_FLAGS[subcommand] : undefined;
	if (!flags) return false;
	if (subcommand === "branch") {
		return rest.every((token) => flags.has(token));
	}
	return rest.every((token) => {
		if (token.startsWith("-")) return flags.has(token) || (subcommand === "log" && /^-\d+$/.test(token));
		return subcommand === "diff" ? isInRepoPath(token) : isRefLike(token);
	});
}

/** Whether one command segment (no chaining) is on the allow-list. */
export function isReadOnlyCommand(segment: string): boolean {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return false;
	if (tokens.length === 1 && tokens[0] === "pwd") return true;
	const [program, ...args] = tokens;
	if (program === "git") return isReadOnlyGit(args);
	if (program && VERSION_TOOLS.has(program) && args.length === 1 && args[0] === "--version") {
		return true;
	}
	return false;
}
