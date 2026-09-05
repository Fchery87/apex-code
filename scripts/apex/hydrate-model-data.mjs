#!/usr/bin/env node
/**
 * `npm run build` regenerates the model catalogs from the models.dev API, so a
 * single dropped connection fails the whole build on every OS. Run 33935459059
 * lost ubuntu that way: ECONNRESET 0.12s into the fetch, before any test ran.
 * The generator lives in a frozen package (ADR 0001) and does not retry, so the
 * bounded retry belongs here, in the fork-owned wrapper the build already calls.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npmSpawnArgs, npmSpawnOptions } from "./npm-command.mjs";

export const RETRY_DELAYS_MS = [2_000, 6_000, 15_000];

export async function hydrateWithRetry({ run, wait, onRetry, delays = RETRY_DELAYS_MS }) {
	for (let attempt = 0; ; attempt += 1) {
		const status = run();
		if (status === 0) return { status: 0, attempts: attempt + 1 };
		if (attempt >= delays.length) return { status, attempts: attempt + 1 };
		onRetry?.({ status, attempt: attempt + 1, delayMs: delays[attempt] });
		await wait(delays[attempt]);
	}
}

function runHydrate() {
	const args = npmSpawnArgs(["--prefix", "packages/ai", "run", "hydrate-model-data"]);
	const result = spawnSync("npm", args, npmSpawnOptions({ stdio: "inherit" }));
	if (result.error) return 1;
	return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { status, attempts } = await hydrateWithRetry({
		run: runHydrate,
		wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		onRetry: ({ status, attempt, delayMs }) =>
			process.stderr.write(`models.dev hydration exited ${status} on attempt ${attempt}; retrying in ${delayMs}ms\n`),
	});
	if (status !== 0) {
		process.stderr.write(`models.dev hydration failed after ${attempts} attempts\n`);
	}
	process.exit(status);
}
