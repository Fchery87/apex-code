import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./validate-release-tag.mjs", import.meta.url));

async function fixture(agentVersion = "0.0.1-alpha.0", cliVersion = agentVersion) {
	const root = await mkdtemp(join(tmpdir(), "apex-release-tag-"));
	await mkdir(join(root, "packages", "agent"), { recursive: true });
	await mkdir(join(root, "packages", "coding-agent"), { recursive: true });
	await writeFile(join(root, "packages", "agent", "package.json"), JSON.stringify({ name: "apex-code-agent-core", version: agentVersion }));
	await writeFile(join(root, "packages", "coding-agent", "package.json"), JSON.stringify({ name: "apex-code", version: cliVersion, dependencies: { "apex-code-agent-core": cliVersion } }));
	return root;
}

function validate(root, tag) {
	return spawnSync(process.execPath, [script, tag, root], { encoding: "utf8" });
}

test("accepts a release tag matching both Apex package versions", async () => {
	const root = await fixture();
	try {
		const result = validate(root, "v0.0.1-alpha.0");
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "0.0.1-alpha.0");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects a tag that differs from package identity", async () => {
	const root = await fixture();
	try {
		const result = validate(root, "v0.0.1-alpha.1");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /does not match/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects mismatched Apex package versions", async () => {
	const root = await fixture("0.0.1-alpha.0", "0.0.1-alpha.1");
	try {
		const result = validate(root, "v0.0.1-alpha.0");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /must match/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
