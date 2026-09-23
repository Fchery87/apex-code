import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

async function readPaths(name) {
	const text = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
	return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")).compilerOptions.paths;
}

const isTypeOnly = (specifier) => specifier.startsWith("highlight.js");

test("the runtime tsconfig is the root's paths without the type-only highlight.js redirect", async () => {
	const rootPaths = await readPaths("tsconfig.json");
	const runtimePaths = await readPaths("tsconfig.runtime.json");

	// tsx and Bun honor `paths` and have no notion of a type-only redirect, so the root's
	// highlight.js mappings make them execute a declaration file. Every other mapping is a
	// runtime claim the launcher depends on, so the two lists must stay otherwise equal.
	const expected = Object.fromEntries(Object.entries(rootPaths).filter(([specifier]) => !isTypeOnly(specifier)));
	assert.deepEqual(runtimePaths, expected);
});

test("the CLI runs from source through tsx", () => {
	const version = execFileSync(
		"npx",
		["tsx", "--tsconfig", "tsconfig.runtime.json", "packages/coding-agent/src/cli.ts", "--version"],
		{ cwd: root, encoding: "utf8" },
	);
	assert.match(version.trim(), /^\d+\.\d+\.\d+/);
});
