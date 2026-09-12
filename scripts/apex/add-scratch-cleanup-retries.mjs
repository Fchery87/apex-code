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
const RETRY_OPTIONS = "maxRetries: 10, retryDelay: 50";

export function spawnsProcesses(source) {
	return SPAWN_CALL.test(source);
}

/**
 * Returns the source with retry options added to every recursive `rmSync` that lacks
 * them, or the input unchanged when there is nothing to do.
 */
export function addRetryOptions(source) {
	return source.replace(RECURSIVE_RM, (match, target, options) => {
		if (options.includes("maxRetries")) return match;
		return `rmSync(${target}, {${options.trimEnd()}, ${RETRY_OPTIONS} })`;
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
