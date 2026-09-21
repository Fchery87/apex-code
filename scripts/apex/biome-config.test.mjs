import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FROZEN_PACKAGE_DIRECTORIES } from "./frozen-packages.mjs";

const biomeUrl = new URL("../../biome.json", import.meta.url);

test("Biome never reads a frozen package", async () => {
	const config = JSON.parse(await readFile(biomeUrl, "utf8"));
	const includes = config.files.includes;

	// `check` runs with `--write`, so anything Biome reads, Biome may rewrite. A frozen
	// package is held byte-identical to its upstream tag, so a rewrite there is a gate
	// failure we inflicted on ourselves -- and the rule that provoked it is one ADR 0001
	// forbids us to satisfy, because the fix would be an edit to upstream's code.
	//
	// This is not hypothetical: upgrading to Biome 2.5.14 turned five frozen files into
	// formatter diffs, `packages/telemetry/src/index.ts` among them, and twenty lint
	// diagnostics in `packages/ai` that no one here is allowed to resolve.
	for (const frozenDirectory of FROZEN_PACKAGE_DIRECTORIES) {
		// Biome 2.2+ wants a bare folder here: a trailing `/**` trips its own
		// `useBiomeIgnoreFolder` rule, which would trade one red gate for another.
		assert.ok(
			includes.includes(`!${frozenDirectory}`),
			`biome.json must exclude frozen package ${frozenDirectory}; add "!${frozenDirectory}" to files.includes`,
		);
	}
});

test("Biome still covers the packages we own", async () => {
	const config = JSON.parse(await readFile(biomeUrl, "utf8"));
	const includes = config.files.includes;

	// The exclusions above are broad globs, so assert the owned packages survive them
	// rather than trusting that a future `!packages/**` never lands.
	for (const owned of ["packages/agent", "packages/coding-agent"]) {
		assert.ok(
			!includes.includes(`!${owned}`) && !includes.includes(`!${owned}/**`),
			`${owned} is forked and must stay linted`,
		);
	}
	assert.ok(includes.some((pattern) => pattern.startsWith("packages/") && !pattern.startsWith("!")));
});
