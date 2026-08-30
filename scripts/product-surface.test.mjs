import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("the npm front door installs and runs Apex Code through npm", async () => {
	const readme = await read("packages/coding-agent/README.md");
	assert.match(readme, /^# Apex Code/m);
	assert.match(readme, /npm install --global apex-code$/m);
	// The packed README must not teach a tag a release no longer writes (ADR 0026).
	assert.doesNotMatch(readme, /apex-code@next/);
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


test("current hosted integrations have no pi.dev runtime default", async () => {
	const files = [
		"packages/coding-agent/src/config.ts",
		"packages/coding-agent/src/core/remote-catalog-provider.ts",
		"packages/coding-agent/src/core/model-runtime.ts",
		"packages/coding-agent/src/cli/args.ts",
		"packages/coding-agent/README.md",
		"packages/coding-agent/docs/environment-variables.md",
		"docs/user-guide.md",
	];
	const current = (await Promise.all(files.map(read))).join("\n");
	assert.doesNotMatch(current, /https:\/\/pi\.dev/);
	assert.match(current, /APEX_CODE_MODEL_CATALOG_URL/);
	assert.match(current, /APEX_CODE_SHARE_VIEWER_URL/);
});
