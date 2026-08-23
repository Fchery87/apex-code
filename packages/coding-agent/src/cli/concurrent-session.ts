import chalk from "chalk";
import { describeSessionLease, type SessionLease } from "../core/session-lease.ts";

export function reportConcurrentSessionRefusal(liveSessions: readonly SessionLease[], cwd: string): void {
	console.error(chalk.yellow("\nAnother Apex Code session is already running here."));
	for (const lease of liveSessions) {
		console.error(chalk.dim(`  ${describeSessionLease(lease)}`));
	}
	console.error(chalk.dim(`  ${cwd}\n`));
	console.error("Two sessions in one working tree overwrite each other's edits and commits.\n");
	console.error(chalk.dim("  git worktree add ../<name> -b <branch>   work in an isolated tree"));
	console.error(chalk.dim("  apex-code --allow-concurrent             proceed anyway\n"));
}
