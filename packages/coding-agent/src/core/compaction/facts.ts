import { runGit } from "../workspace/git-observer.ts";

/**
 * Spec 2026-10-23-coding-turn-quality.md, slice 8. Facts the summary model
 * must not be trusted to remember. Empty when git has nothing to say.
 */
export async function compactionFacts(
	cwd: string,
	lastFailure?: { command: string; exitCode: number },
): Promise<string> {
	const parts: string[] = [];
	const stat = await runGit(cwd, ["diff", "--stat"], 5_000);
	if (stat.ok) {
		const text = stat.stdout.toString("utf8").trim();
		if (text) parts.push(`<git-diff-stat>\n${text}\n</git-diff-stat>`);
	}
	if (lastFailure) {
		parts.push(`<last-failure command="${lastFailure.command}" exit="${lastFailure.exitCode}"></last-failure>`);
	}
	return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}
