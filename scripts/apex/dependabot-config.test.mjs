import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { FROZEN_PACKAGE_DIRECTORIES } from "./frozen-packages.mjs";

const dependabotUrl = new URL("../../.github/dependabot.yml", import.meta.url);

test("Dependabot scans the workspace root only, never a frozen package", async () => {
	const source = await readFile(dependabotUrl, "utf8");
	const config = parse(source);

	const npmDirectories = config.updates.filter((update) => update["package-ecosystem"] === "npm").map((update) => update.directory);

	// One entry, at the root, because this is an npm workspaces monorepo with a single
	// authoritative `package-lock.json` and CI installs with `npm ci` from the root.
	//
	// A per-package entry looks tidier and cannot work: Dependabot treats that directory as
	// an independent project, edits its `package.json`, and leaves the root lockfile alone.
	// Every such pull request then dies at install with "Missing: <pkg> from lock file",
	// before a single test runs. This assertion previously required exactly those entries,
	// which is why nine consecutive Dependabot pull requests sat red.
	assert.deepEqual(npmDirectories, ["/"]);

	for (const frozenDirectory of FROZEN_PACKAGE_DIRECTORIES) {
		const asDependabotPath = `/${frozenDirectory}`;
		assert.ok(!npmDirectories.includes(asDependabotPath), `Dependabot must not scan frozen package ${frozenDirectory}`);
	}

	for (const update of config.updates) {
		assert.equal(update.schedule.interval, "weekly");
	}

	assert.ok(
		config.updates.some((update) => update["package-ecosystem"] === "github-actions" && update.directory === "/"),
		"expected a github-actions ecosystem entry tracking pinned action SHAs",
	);
});
