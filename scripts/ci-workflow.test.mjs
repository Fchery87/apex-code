import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const path = new URL("../.github/workflows/ci.yml", import.meta.url);

test("CI requires three OSes from a spaced checkout with immutable actions", async () => {
	const source = await readFile(path, "utf8");
	const workflow = parse(source);
	const job = workflow.jobs["build-check-test"];
	assert.deepEqual(job.strategy.matrix.os, ["ubuntu-latest", "macos-latest", "windows-latest"]);
	assert.equal(job["continue-on-error"], undefined);
	assert.match(job.defaults.run["working-directory"], / /);
	assert.match(source, /Assert spaced checkout/);
	assert.match(source, /case "\$PWD" in \*" "\*/);
	for (const match of source.matchAll(/uses:\s*actions\/(?:checkout|setup-node)@([^\s]+)/g)) {
		assert.match(match[1], /^[0-9a-f]{40}$/);
	}
});

test("Windows CI parses the standalone PowerShell installer", async () => {
	const source = await readFile(path, "utf8");
	assert.match(source, /runner\.os == 'Windows'/);
	assert.match(source, /shell:\s*pwsh/);
	assert.match(source, /Parser\]::ParseFile/);
	assert.match(source, /install\.ps1/);
});
