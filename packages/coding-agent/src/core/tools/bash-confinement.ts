export interface ConfineBashInput {
	enabled: boolean;
	command: string;
	cwd: string;
	/** Absolute path of the helper, or undefined when it is not on PATH. */
	helperPath: string | undefined;
	platform?: NodeJS.Platform;
}

export interface ConfineBashResult {
	run: boolean;
	command?: string;
	argv?: string[];
	refusal?: string;
}

const HELPER = "bwrap";

/**
 * Decide how a bash call runs. Off means the command is unchanged. On with no
 * helper refuses the call. The command is never run unconfined when the user
 * asked for confinement. This covers bash only.
 */
export function confineBash(input: ConfineBashInput): ConfineBashResult {
	if (!input.enabled) return { run: true, command: input.command };
	const platform = input.platform ?? process.platform;
	if (platform === "win32") {
		return { run: false, refusal: "Bash confinement is not available on Windows. The command was not run." };
	}
	if (!input.helperPath) {
		return {
			run: false,
			refusal: `Bash confinement needs ${HELPER}, and it is not installed. The command was not run.`,
		};
	}
	return {
		run: true,
		argv: [
			input.helperPath,
			"--ro-bind",
			"/",
			"/",
			"--bind",
			input.cwd,
			input.cwd,
			"--unshare-net",
			"--",
			"bash",
			"-c",
			input.command,
		],
	};
}
