/**
 * Measure what each module costs the supervisor at launch.
 *
 * `core/sandbox/default-hosts.ts` documents two hard-won budgets: it materialises the
 * provider host list rather than importing the provider registry (~190ms), and
 * duplicates the update-check host rather than importing `version-check.ts` (~40ms).
 * Both comments exist because the supervisor pays module load on every single launch,
 * before the child starts.
 *
 * Anything newly imported by `core/sandbox/cli-launch.ts` is therefore a real cost,
 * and "it is probably already loaded" is a claim to measure rather than assume.
 *
 * Each row runs in its own process so nothing is served from a warm module cache.
 * `--json` prints machine-readable output.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `--dist` measures the compiled output users actually run. Default measures source
 * through tsx, whose transpilation dominates every reading and makes the numbers
 * useless for comparing against a millisecond budget. Prefer `--dist` for any claim
 * about launch cost; run `npm run build --workspace packages/coding-agent` first.
 */
const useDist = process.argv.includes("--dist");
const codingAgent = join(repoRoot, "packages/coding-agent", useDist ? "dist" : "src");
const extension = useDist ? ".js" : ".ts";

/**
 * Each case names the modules to import in order. Only the last is timed, so a case
 * listing prerequisites first measures what that module adds *on top of* them, which
 * is the number that matters for a module the supervisor already loads.
 */
const CASES = [
	{ name: "settings-manager (already imported)", modules: ["core/settings-manager"] },
	{ name: "default-hosts (already imported)", modules: ["core/sandbox/default-hosts"] },
	{ name: "web-search-provider (cold)", modules: ["core/web-search-provider"] },
	{
		name: "web-search-provider (after settings-manager)",
		modules: ["core/settings-manager", "core/web-search-provider"],
		measures: "the added cost cli-launch actually pays",
	},
	{ name: "cli-launch (whole supervisor path)", modules: ["core/sandbox/cli-launch"] },
];

const RUNNER = `
const paths = process.argv.slice(1);
for (const path of paths.slice(0, -1)) await import(path);
const target = paths[paths.length - 1];
const start = performance.now();
await import(target);
process.stdout.write(String(performance.now() - start));
`;

function measure(modules, samples = 5) {
	const timings = [];
	for (let sample = 0; sample < samples; sample++) {
		const args = useDist ? [] : ["--import", "tsx"];
		const result = spawnSync(
			process.execPath,
			[...args, "--input-type=module", "-e", RUNNER, ...modules.map((m) => join(codingAgent, m) + extension)],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		if (result.status !== 0) {
			throw new Error(`Failed to import ${modules.join(", ")}: ${result.stderr.trim().split("\n").slice(-3).join(" ")}`);
		}
		timings.push(Number(result.stdout));
	}
	// Median, because a cold page cache makes the first sample of any process unrepresentative.
	return timings.sort((a, b) => a - b)[Math.floor(timings.length / 2)];
}

const asJson = process.argv.includes("--json");
const results = CASES.map((testCase) => ({ ...testCase, medianMs: measure(testCase.modules) }));

if (asJson) {
	console.log(JSON.stringify(results, null, 2));
} else {
	console.log(useDist ? "Compiled output (dist):" : "Source through tsx -- transpilation dominates; use --dist for real numbers:");
	const width = Math.max(...results.map((r) => r.name.length));
	for (const result of results) {
		const note = result.measures ? `  <- ${result.measures}` : "";
		console.log(`${result.name.padEnd(width)}  ${result.medianMs.toFixed(1).padStart(7)} ms${note}`);
	}
}
