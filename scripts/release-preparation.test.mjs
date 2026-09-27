import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const releaseScript = await readFile(new URL("./release.mjs", import.meta.url), "utf8");

test("release preparation runs the packed coding-agent consumer smoke test", () => {
	assert.equal(packageJson.scripts["check:package-install"], "node scripts/coding-agent-consumer.mjs");
	assert.match(releaseScript, /run\("npm run check:package-install"\)/);
});
