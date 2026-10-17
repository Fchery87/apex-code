/**
 * The environment block of the system prompt (HR.16): where the model is running, so it
 * does not guess the date, the operating system, or the shell.
 *
 * It is the last prompt section, so every earlier byte stays cacheable when only the date
 * changes. It is built once per session start and again on `/reload` or a model switch.
 */

import { spawnSync } from "node:child_process";

export interface GitState {
	branch: string;
	dirty: boolean;
}

export interface EnvironmentFacts {
	date: string;
	platform: string;
	shell: string;
	model?: string;
	git: GitState | undefined;
}

export function buildEnvironmentSection(facts: EnvironmentFacts): string {
	const lines = [
		`Date: ${facts.date}`,
		`Platform: ${facts.platform}`,
		`Shell: ${facts.shell}`,
		facts.model ? `Model: ${facts.model}` : undefined,
		facts.git
			? `Git: branch ${facts.git.branch}${facts.git.dirty ? ", with uncommitted changes" : ", clean"}`
			: "Git: the working directory is not a git repository",
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

/** Reads the branch and dirty state, or undefined outside a repository or when git is unavailable. */
export function readGitState(cwd: string): GitState | undefined {
	const run = (args: string[]) => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2000 });
		return result.status === 0 ? result.stdout : undefined;
	};
	const branch = run(["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
	if (!branch) return undefined;
	const status = run(["status", "--porcelain"]);
	return { branch, dirty: status !== undefined && status.trim().length > 0 };
}

/** The live facts for a session in `cwd`, using the system clock, platform, and shell. */
export function currentEnvironmentSection(cwd: string, model: string | undefined): string {
	return buildEnvironmentSection({
		date: new Date().toISOString().slice(0, 10),
		platform: process.platform,
		shell: process.env.SHELL ?? (process.platform === "win32" ? "powershell" : "sh"),
		model,
		git: readGitState(cwd),
	});
}
