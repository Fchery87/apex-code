import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * package.json's version:patch/minor/major/set scripts previously ran
 * `npm version <target> --workspaces`, which bumps every workspace package --
 * including the six frozen, consumed Pi packages (ADR 0001). This proves the
 * fixed invocation (`--workspace packages/agent --workspace packages/coding-agent`,
 * matching package.json's version:* scripts) only ever bumps the two Apex-owned
 * packages, using the real `npm version` command rather than reimplementing its
 * semantics.
 */

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

test("npm version scoped to the two Apex-owned workspaces leaves a frozen package untouched", async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-version-bump-scope-"));
	try {
		await writeManifest(root, ".", { name: "fixture-root", private: true, workspaces: ["packages/*"] });
		await writeManifest(root, "packages/agent", { name: "apex-code-agent-core", version: "1.0.0" });
		await writeManifest(root, "packages/coding-agent", { name: "apex-code", version: "1.0.0" });
		await writeManifest(root, "packages/ai", { name: "@earendil-works/pi-ai", version: "0.84.1" });

		spawnSync("git", ["init", "-q"], { cwd: root });
		spawnSync("git", ["add", "-A"], { cwd: root });
		spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"], {
			cwd: root,
		});

		const result = spawnSync(
			"npm",
			[
				"version",
				"patch",
				"--workspace",
				"packages/agent",
				"--workspace",
				"packages/coding-agent",
				"--no-git-tag-version",
				"--no-workspaces-update",
			],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);

		const agentManifest = JSON.parse(await readFile(join(root, "packages/agent/package.json"), "utf8"));
		const codingAgentManifest = JSON.parse(await readFile(join(root, "packages/coding-agent/package.json"), "utf8"));
		const frozenStandInManifest = JSON.parse(await readFile(join(root, "packages/ai/package.json"), "utf8"));

		assert.equal(agentManifest.version, "1.0.1");
		assert.equal(codingAgentManifest.version, "1.0.1");
		// The real defect this proves fixed: --workspaces (no scope) would have
		// bumped this frozen-package stand-in to 0.84.2 as well.
		assert.equal(frozenStandInManifest.version, "0.84.1");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
