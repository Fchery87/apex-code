import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("the npm front door installs and runs Apex Code through npm", async () => {
	const readme = await read("packages/coding-agent/README.md");
	assert.match(readme, /^# Apex Code/m);
	assert.match(readme, /npm install --global apex-code@next/);
	assert.match(readme, /apex-code --version/);
	assert.doesNotMatch(readme, /pi\.dev\/install\.sh/);
	assert.doesNotMatch(readme, /^pi(?:\s|$)/m);
	assert.match(readme, /sends no install or update telemetry/);
	assert.match(readme, /~\/\.apex-code\/agent/);
});

test("current runtime product instructions identify Apex Code", async () => {
	const files = ["packages/coding-agent/src/core/system-prompt.ts", "packages/coding-agent/src/cli/auth-command.ts", "packages/coding-agent/src/package-manager-cli.ts", "packages/coding-agent/src/main.ts"];
	const current = (await Promise.all(files.map(read))).join("\n");
	assert.doesNotMatch(current, /operating inside pi|Hint:.*pi -ne|\n  pi auth/);
	assert.match(current, /operating inside Apex Code/);
	assert.match(current, /apex-code auth/);
	assert.match(current, /apex-code -ne/);
});

test("publishing targets exactly the Apex-owned packages in dependency order", async () => {
	const { getPublicWorkspacePackages } = await import("./release-packages.mjs");
	assert.deepEqual(getPublicWorkspacePackages().map(({ name }) => name), ["apex-code-agent-core", "apex-code"]);
});
