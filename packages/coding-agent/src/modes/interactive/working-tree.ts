import { spawn } from "node:child_process";

const DEFAULT_MAX_DIFF_LINES = 200;

export interface WorkingTreeOptions {
	/** Diff lines kept before the report says how many were omitted. */
	maxDiffLines?: number;
}

interface GitOutput {
	readonly ok: boolean;
	readonly stdout: string;
}

function git(cwd: string, args: string[]): Promise<GitOutput> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd, shell: false, stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.on("error", () => resolve({ ok: false, stdout: "" }));
		child.on("close", (code) => resolve({ ok: code === 0, stdout }));
	});
}

/**
 * The working tree as text. Read only: status and diff, never add, stash, or commit.
 * Untracked files are named, not dumped, because their contents can be anything.
 */
export async function workingTreeReport(cwd: string, options: WorkingTreeOptions = {}): Promise<string> {
	const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (!inside.ok || inside.stdout.trim() !== "true") return "Not a git repository.";

	const status = await git(cwd, ["status", "--short"]);
	const diff = await git(cwd, ["diff", "HEAD"]);
	const maxLines = options.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;
	const diffLines = diff.stdout.split("\n");
	const shown = diffLines.slice(0, maxLines);
	const omitted = diffLines.length - shown.length;

	const parts = [status.stdout.trim() || "Working tree clean."];
	if (shown.join("").trim().length > 0) parts.push(shown.join("\n"));
	if (omitted > 0) parts.push(`${omitted} diff ${omitted === 1 ? "line" : "lines"} omitted.`);
	return parts.join("\n\n");
}
