#!/usr/bin/env node
/**
 * `npm run build` needs packages/ai/src/providers/data populated before
 * build:offline validates and compiles it. Generating it from the models.dev
 * API made every build depend on a third-party request: run 33840994104 broke
 * when the catalog changed under us, and run 33935459059 lost ubuntu to a
 * single ECONNRESET. Builds copy a committed snapshot instead, and only
 * --refresh talks to the network.
 *
 * The snapshot lives outside packages/ai because ADR 0001 freezes that package
 * byte-identical to upstream, and upstream does not commit this directory.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmSpawnArgs, npmSpawnOptions } from "./npm-command.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const VENDOR_DIR = join(REPO_ROOT, "vendor", "model-data");
export const TARGET_DIR = join(REPO_ROOT, "packages", "ai", "src", "providers", "data");
export const MANIFEST_FILE = ".manifest.json";
export const RETRY_DELAYS_MS = [2_000, 6_000, 15_000];

export function assertSnapshot(dir, { exists = existsSync, list = readdirSync } = {}) {
	if (!exists(join(dir, MANIFEST_FILE))) {
		throw new Error(`No model-data snapshot at ${dir}. Run \`npm run refresh:model-data\` to create one.`);
	}
	const files = list(dir).filter((entry) => entry.endsWith(".json") && entry !== MANIFEST_FILE);
	if (files.length === 0) {
		throw new Error(`Model-data snapshot at ${dir} has no provider files.`);
	}
	return files;
}

/** Replace `to` with the contents of `from` so a partial earlier run cannot survive. */
export function replaceDirectory(from, to, fs = { rmSync, mkdirSync, cpSync }) {
	fs.rmSync(to, { recursive: true, force: true });
	fs.mkdirSync(dirname(to), { recursive: true });
	fs.cpSync(from, to, { recursive: true });
}

export async function retry({ run, wait, onRetry, delays = RETRY_DELAYS_MS }) {
	for (let attempt = 0; ; attempt += 1) {
		const status = run();
		if (status === 0) return { status: 0, attempts: attempt + 1 };
		if (attempt >= delays.length) return { status, attempts: attempt + 1 };
		onRetry?.({ status, attempt: attempt + 1, delayMs: delays[attempt] });
		await wait(delays[attempt]);
	}
}

function generateFromModelsDev() {
	const args = npmSpawnArgs(["--prefix", "packages/ai", "run", "hydrate-model-data"]);
	const result = spawnSync("npm", args, npmSpawnOptions({ stdio: "inherit", cwd: REPO_ROOT }));
	if (result.error) return 1;
	return result.status ?? 1;
}

async function main(refresh) {
	if (!refresh) {
		assertSnapshot(VENDOR_DIR);
		replaceDirectory(VENDOR_DIR, TARGET_DIR);
		process.stdout.write(`Model data restored from ${VENDOR_DIR}\n`);
		return 0;
	}

	const { status, attempts } = await retry({
		run: generateFromModelsDev,
		wait: (ms) => new Promise((done) => setTimeout(done, ms)),
		onRetry: ({ status, attempt, delayMs }) =>
			process.stderr.write(`models.dev hydration exited ${status} on attempt ${attempt}; retrying in ${delayMs}ms\n`),
	});
	if (status !== 0) {
		process.stderr.write(`models.dev hydration failed after ${attempts} attempts\n`);
		return status;
	}
	assertSnapshot(TARGET_DIR);
	replaceDirectory(TARGET_DIR, VENDOR_DIR);
	process.stdout.write(`Model data snapshot updated at ${VENDOR_DIR}\n`);
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		process.exit(await main(process.argv.includes("--refresh")));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}
