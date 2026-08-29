import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

test("root test command includes all Apex-owned workspace tests", async () => {
	const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
	assert.match(packageJson.scripts.test, /--workspace packages\/agent/);
	assert.match(packageJson.scripts.test, /--workspace packages\/coding-agent/);
	assert.doesNotMatch(packageJson.scripts.test, /--exclude test\/config\.test\.ts/);
});
