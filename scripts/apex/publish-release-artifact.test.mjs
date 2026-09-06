import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReleaseArtifactRecord, REQUIRED_STANDALONE_ARTIFACTS, writeReleaseArtifactManifest } from "./packed-product-surface.mjs";
import { publishReleaseArtifact } from "./publish-release-artifact.mjs";

const IDENTITY = {
	expectedGitCommit: "0123456789abcdef0123456789abcdef01234567",
	workflowIdentity: "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v1.2.3",
};

/**
 * A complete, valid release record: the manifest contract (RI-B4/RI-B7) is
 * exactly the two owned packages plus the six standalone archives, so a
 * publisher test that builds a one-package fixture is testing a document the
 * release can never actually produce.
 */
async function writeCompleteManifest(root) {
	const tarballPaths = {};
	const records = [];
	for (const [index, packageName] of ["apex-code-agent-core", "apex-code"].entries()) {
		const tarballPath = join(root, `${packageName}-1.2.3.tgz`);
		await writeFile(tarballPath, `tested bytes ${index}`);
		tarballPaths[packageName] = tarballPath;
		records.push(createReleaseArtifactRecord({ tarballPath, packed: { name: packageName, version: "1.2.3" }, ...IDENTITY }));
	}
	const standaloneDirectory = join(root, "standalone");
	await mkdir(standaloneDirectory, { recursive: true });
	for (const filename of REQUIRED_STANDALONE_ARTIFACTS) await writeFile(join(standaloneDirectory, filename), `binary-${filename}`);
	const manifestPath = join(root, "release-artifacts.json");
	writeReleaseArtifactManifest(manifestPath, records, { standaloneDirectory });
	return { manifestPath, tarballPaths };
}

test("publisher passes the retained tested tarball to npm and rejects later byte changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-publish-artifact-"));
	try {
		const { manifestPath, tarballPaths } = await writeCompleteManifest(root);
		const logPath = join(root, "args.json");
		const fakeNpm = join(root, "npm");
		await writeFile(fakeNpm, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });

		publishReleaseArtifact({ manifestPath, packageName: "apex-code", tag: "next", npmExecutable: fakeNpm });
		assert.deepEqual(JSON.parse(await readFile(logPath, "utf8")), [
			"publish", tarballPaths["apex-code"], "--access", "public", "--provenance", "--tag", "next", "--ignore-scripts",
		]);

		await writeFile(tarballPaths["apex-code"], "changed bytes");
		assert.throws(
			() => publishReleaseArtifact({ manifestPath, packageName: "apex-code", tag: "next", npmExecutable: fakeNpm }),
			/changed after testing/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("publisher rejects a manifest that is not one complete, self-consistent release identity", async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-publish-artifact-invalid-"));
	try {
		const { manifestPath } = await writeCompleteManifest(root);
		const document = JSON.parse(await readFile(manifestPath, "utf8"));

		const drifted = structuredClone(document);
		drifted.artifacts[1].expectedGitCommit = "f".repeat(40);
		const driftedPath = join(root, "drifted.json");
		await writeFile(driftedPath, JSON.stringify(drifted));
		assert.throws(
			() => publishReleaseArtifact({ manifestPath: driftedPath, packageName: "apex-code", tag: "next", npmExecutable: "false" }),
			/does not match package records/,
		);

		const truncated = structuredClone(document);
		truncated.artifacts = truncated.artifacts.slice(0, 1);
		const truncatedPath = join(root, "truncated.json");
		await writeFile(truncatedPath, JSON.stringify(truncated));
		assert.throws(
			() => publishReleaseArtifact({ manifestPath: truncatedPath, packageName: "apex-code-agent-core", tag: "next", npmExecutable: "false" }),
			/exactly the two Apex-owned packages/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
