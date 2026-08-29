import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

test("root test command includes all Apex-owned workspace tests", async () => {
	const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
	assert.match(packageJson.scripts.test, /--workspace packages\/agent/);
	assert.match(packageJson.scripts.test, /--workspace packages\/coding-agent/);
	// Any exclusion, not the one that was found. `test/config.test.ts` sat outside CI for
	// twenty days because nothing objected to dropping a file, and naming that file here
	// would leave the next one to be found the same way.
	assert.doesNotMatch(packageJson.scripts.test, /--exclude\b/);
});
