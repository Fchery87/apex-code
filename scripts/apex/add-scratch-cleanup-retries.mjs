#!/usr/bin/env node
/**
 * Add `maxRetries` to recursive `rmSync` cleanup in tests that spawn child processes.
 *
 * Windows keeps a directory handle open briefly after a process exits, so removing a
 * scratch directory right after killing a process tree races and throws EBUSY. Node's
 * `rmSync` retries EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM when `maxRetries` is set
 * and `recursive` is true, which is exactly this case. POSIX is unaffected, because with
 * no error there is nothing to retry.
 *
 * This is the fifth occurrence of the shape in this repository. `docs/specs/2026-08-18-lsp.md`
 * records it as "a hard EBUSY failure on Windows's stricter file locking", and the
 * 2026-09-09 plan lists an "EBUSY scratch cleanup" among five Windows repairs. Rather
 * than repair a sixth by hand, `--check` runs in `npm run check` so the next one fails
 * on any machine instead of intermittently on Windows CI.
 *
 * Scoped to test files that actually start processes. A test that never spawns cannot
 * lose the race, and rewriting all 188 cleanup sites would be a large diff for no
 * behavior change.
 *
 * Usage:
 *   node scripts/apex/add-scratch-cleanup-retries.mjs           # rewrite
 *   node scripts/apex/add-scratch-cleanup-retries.mjs --check   # exit 1 if any remain
 */

import { globSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_ROOTS = ["packages/coding-agent/test", "packages/agent/test"];

/** Anything that can leave a live or just-dead process holding a directory handle. */
const SPAWN_CALL = /\b(spawn|spawnSync|execFile|execFileSync|runPolicyCommand|fork)\s*\(/;
const RECURSIVE_RM = /rmSync\(([^,]+),\s*\{([^}]*\brecursive:\s*true\b[^}]*)\}\)/g;
/** Word-boundary match so a similarly named key or a comment cannot pass for the real option. */
const RETRIES_ENABLED = /\bmaxRetries\s*:/;
const DELAY_SET = /\bretryDelay\s*:/;

export function spawnsProcesses(source) {
	return SPAWN_CALL.test(source);
}

/**
 * Returns the source with retry options added to every recursive `rmSync` that lacks
 * them, or the input unchanged when there is nothing to do.
 *
 * `maxRetries` is the switch that turns retrying on, so its presence means the site
 * already handles the race and is left alone even if it tunes a different delay.
 * `retryDelay` alone does nothing, because Node ignores it without `maxRetries`.
 */
export function addRetryOptions(source) {
	return source.replace(RECURSIVE_RM, (match, target, options) => {
		if (RETRIES_ENABLED.test(options)) return match;
		// A trailing comma in the original object would otherwise produce `,,`.
		const normalized = options.trimEnd().replace(/,$/, "");
		const additions = ["maxRetries: 10"];
		// `retryDelay` without `maxRetries` is inert, but a site may still carry one, and
		// appending a second would leave a duplicate key.
		if (!DELAY_SET.test(normalized)) additions.push("retryDelay: 50");
		return `rmSync(${target}, {${normalized}, ${additions.join(", ")} })`;
	});
}

/** True when this source would be rewritten, i.e. it races on Windows today. */
export function needsRetryOptions(source) {
	return spawnsProcesses(source) && addRetryOptions(source) !== source;
}

export function collectTestFiles(repoRoot, roots = TEST_ROOTS) {
	const files = [];
	for (const root of roots) {
		const absoluteRoot = resolve(repoRoot, root);
		for (const relative of globSync("**/*.ts", { cwd: absoluteRoot })) {
			files.push(resolve(absoluteRoot, relative));
		}
	}
	return files;
}

function main() {
	const check = process.argv.includes("--check");
	const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
	const offenders = [];
	let rewritten = 0;

	for (const path of collectTestFiles(repoRoot)) {
		const before = readFileSync(path, "utf8");
		if (!needsRetryOptions(before)) continue;
		if (check) offenders.push(path.slice(repoRoot.length + 1));
		else {
			writeFileSync(path, addRetryOptions(before));
			rewritten += 1;
		}
	}

	if (!check) {
		console.log(`Added retry options in ${rewritten} file(s).`);
		return;
	}
	if (offenders.length === 0) {
		console.log("Every process-spawning test retries its recursive scratch cleanup.");
		return;
	}
	console.error("These tests spawn processes and remove a scratch directory without retries.");
	console.error("Windows fails them intermittently with EBUSY. Run this script without --check.");
	for (const offender of offenders) console.error(`- ${offender}`);
	process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main();
}
