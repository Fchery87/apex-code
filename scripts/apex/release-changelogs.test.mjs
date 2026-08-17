import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addUnreleasedSection, getOwnedChangelogPaths, updateChangelogsForRelease } from "./release-changelogs.mjs";

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	return directory;
}

async function setupOwnedPackages(root) {
	await writeManifest(root, "packages/agent", { name: "apex-code-agent-core", version: "1.2.3" });
	await writeManifest(root, "packages/coding-agent", { name: "apex-code", version: "1.2.3" });
	// Different real-world heading text between the two Apex-owned changelogs --
	// the defect this fixes: a fixed "# Changelog" literal previously matched
	// only one of them.
	await writeFile(join(root, "packages/agent", "CHANGELOG.md"), "# Changelog\n\n## [1.2.2] - 2026-08-01\n\n- prior entry\n");
	await writeFile(
		join(root, "packages/coding-agent", "CHANGELOG.md"),
		"# Apex Code changelog\n\n## 1.2.2\n\n- prior entry\n",
	);
}

test("getOwnedChangelogPaths finds only the two Apex-owned changelogs", async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-release-changelogs-"));
	try {
		await setupOwnedPackages(root);
		await writeManifest(root, "packages/ai", { name: "@earendil-works/pi-ai", version: "0.84.1" });
		await writeFile(join(root, "packages/ai", "CHANGELOG.md"), "# Changelog\n\n## [0.84.1]\n");

		const paths = getOwnedChangelogPaths(root);
		assert.deepEqual(
			paths.map((path) => path.replace(root, "")).sort(),
			[join("/packages/agent", "CHANGELOG.md"), join("/packages/coding-agent", "CHANGELOG.md")].sort(),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("addUnreleasedSection inserts after the title heading regardless of its exact text", async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-release-changelogs-"));
	try {
		await setupOwnedPackages(root);
		const paths = getOwnedChangelogPaths(root);

		addUnreleasedSection(paths);

		const agentContent = await readFile(join(root, "packages/agent/CHANGELOG.md"), "utf8");
		assert.match(agentContent, /^# Changelog\n\n## \[Unreleased\]\n\n## \[1\.2\.2\]/);

		const codingAgentContent = await readFile(join(root, "packages/coding-agent/CHANGELOG.md"), "utf8");
		assert.match(codingAgentContent, /^# Apex Code changelog\n\n## \[Unreleased\]\n\n## 1\.2\.2/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("updateChangelogsForRelease replaces [Unreleased] with the version and date in both owned changelogs", async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-release-changelogs-"));
	try {
		await setupOwnedPackages(root);
		const paths = getOwnedChangelogPaths(root);
		addUnreleasedSection(paths);

		updateChangelogsForRelease(paths, "1.3.0", "2026-08-16");

		const agentContent = await readFile(join(root, "packages/agent/CHANGELOG.md"), "utf8");
		assert.match(agentContent, /## \[1\.3\.0\] - 2026-08-16/);
		assert.doesNotMatch(agentContent, /\[Unreleased\]/);

		const codingAgentContent = await readFile(join(root, "packages/coding-agent/CHANGELOG.md"), "utf8");
		assert.match(codingAgentContent, /## \[1\.3\.0\] - 2026-08-16/);
		assert.doesNotMatch(codingAgentContent, /\[Unreleased\]/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
