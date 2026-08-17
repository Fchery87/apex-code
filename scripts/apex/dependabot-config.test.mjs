import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import { FROZEN_PACKAGE_DIRECTORIES } from "./frozen-packages.mjs";

const dependabotUrl = new URL("../../.github/dependabot.yml", import.meta.url);

test("Dependabot scans the root and the two Apex-owned packages, never a frozen package", async () => {
	const source = await readFile(dependabotUrl, "utf8");
	const config = parse(source);

	const npmDirectories = config.updates.filter((update) => update["package-ecosystem"] === "npm").map((update) => update.directory);
	assert.deepEqual(npmDirectories.sort(), ["/", "/packages/agent", "/packages/coding-agent"].sort());

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
