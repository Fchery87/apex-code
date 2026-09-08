import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "../release-packages.mjs";
import { attachReleaseArtifactIdentity, describeTreeLockfileMismatch, generateAllSboms, generateSbomFor } from "./generate-sbom.mjs";
import { npmSpawnArgs, npmSpawnOptions } from "./npm-command.mjs";

/**
 * These tests fake `npm` with an extensionless shebang script on PATH, which
 * Windows cannot execute and would not find with a POSIX `:` separator either.
 * The scripts under test only ever run on ubuntu-latest and macos-latest
 * (.github/workflows/release.yml), so porting the shim would prove something
 * about a platform the release path never touches. Both blockers are the
 * harness, not the behaviour, and Linux and macOS cover the behaviour.
 */
const posixShimOnly = process.platform === "win32" ? "release tooling is verified on Linux and macOS" : false;

const bothOwnedPackagesAreBuilt = getPublicWorkspacePackages().every((pkg) => existsSync(join(pkg.directory, "dist")));

test(
	"generates a real, non-empty CycloneDX SBOM with real hashes for each Apex-owned package (requires npm run build first)",
	{ skip: !bothOwnedPackagesAreBuilt },
	async () => {
		const outDir = await mkdtemp(join(tmpdir(), "apex-sbom-"));
		try {
			const written = generateAllSboms(outDir);
			assert.equal(written.length, 2);
			for (const entry of written) {
				assert.ok(entry.componentCount > 0, `${entry.name} SBOM has no components`);
				const { readFile } = await import("node:fs/promises");
				const document = JSON.parse(await readFile(entry.path, "utf8"));
				assert.equal(document.bomFormat, "CycloneDX");
				assert.ok(Array.isArray(document.components) && document.components.length > 0);
				// At least one real, hash-bearing dependency, proving this is a
				// genuine dependency-tree scan, not a stub or placeholder document.
				assert.ok(document.components.some((component) => Array.isArray(component.hashes) && component.hashes.length > 0));
			}
		} finally {
			await rm(outDir, { recursive: true, force: true });
		}
	},
);

test("generateSbomFor refuses to treat an empty component list as evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-sbom-empty-"));
	try {
		// A minimal workspace root of its own -- npm sbom --workspace requires the
		// target to be a registered workspace of whatever `cwd` it runs from.
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ name: "fixture-root", version: "1.0.0", private: true, workspaces: ["pkg"] }, null, "\t"),
		);
		const packageDirectory = join(root, "pkg");
		await mkdir(packageDirectory, { recursive: true });
		// No dependencies at all -- exactly the silent zero-component case this
		// guard exists to catch (npm sbom still exits 0).
		await writeFile(
			join(packageDirectory, "package.json"),
			JSON.stringify({ name: "apex-sbom-empty-fixture", version: "1.0.0" }, null, "\t"),
		);
		spawnSync("npm", npmSpawnArgs(["install", "--ignore-scripts"]), npmSpawnOptions({ cwd: root }));

		assert.throws(
			() => generateSbomFor({ name: "apex-sbom-empty-fixture", directory: packageDirectory }, root),
			/no real dependency components/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("describeTreeLockfileMismatch names the stale tree and the remedy", () => {
	// Real stderr captured from `npm sbom` after a lockfile-only dependabot bump
	// landed while node_modules still held the old version.
	const stderr = ["npm error code ESBOMPROBLEMS", "npm error invalid: esbuild@0.28.1, 0.28.2 required by pi-monorepo@0.0.3"].join("\n");
	const message = describeTreeLockfileMismatch(stderr);
	assert.ok(message, "expected a diagnosis for an ESBOMPROBLEMS tree");
	assert.match(message, /esbuild/);
	assert.match(message, /0\.28\.1/);
	assert.match(message, /0\.28\.2/);
	assert.match(message, /npm install/);
});

test("describeTreeLockfileMismatch returns undefined for unrelated npm failures", () => {
	assert.equal(describeTreeLockfileMismatch("npm error code E404\nnpm error 404 Not Found - GET https://registry.example.org/x"), undefined);
	assert.equal(describeTreeLockfileMismatch(""), undefined);
});


test("SBOM records the retained release artifact identities", () => {
	const document = { bomFormat: "CycloneDX", metadata: {} };
	const records = [
		{ packageName: "apex-code-agent-core", version: "1.2.3", sha256: "a".repeat(64), integrity: "sha512-core" },
		{ packageName: "apex-code", version: "1.2.3", sha256: "b".repeat(64), integrity: "sha512-cli" },
	];
	attachReleaseArtifactIdentity(document, records);
	assert.deepEqual(document.metadata.properties, [
		{ name: "apex:release-artifact:apex-code-agent-core:sha256", value: "a".repeat(64) },
		{ name: "apex:release-artifact:apex-code-agent-core:integrity", value: "sha512-core" },
		{ name: "apex:release-artifact:apex-code:sha256", value: "b".repeat(64) },
		{ name: "apex:release-artifact:apex-code:integrity", value: "sha512-cli" },
	]);
});


// RI-B6: the release-install path parsed, annotated, and wrote npm's output
// without the structural/non-empty checks the normal path applies, so an
// offline fake npm returning `{}` exited 0 and produced a 0-component SBOM
// that the release then uploaded as evidence.
async function writeReleaseManifestFixture(root) {
	const { createReleaseArtifactRecord, REQUIRED_STANDALONE_ARTIFACTS, writeReleaseArtifactManifest } = await import("./packed-product-surface.mjs");
	const records = [];
	for (const [index, name] of ["apex-code-agent-core", "apex-code"].entries()) {
		const tarballPath = join(root, `pkg-${index}.tgz`);
		await writeFile(tarballPath, `tested-bytes-${index}`);
		records.push(createReleaseArtifactRecord({
			tarballPath,
			packed: { name, version: "1.2.3" },
			expectedGitCommit: "0123456789abcdef0123456789abcdef01234567",
			workflowIdentity: "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v1.2.3",
		}));
	}
	const standaloneDirectory = join(root, "standalone");
	await mkdir(standaloneDirectory, { recursive: true });
	for (const filename of REQUIRED_STANDALONE_ARTIFACTS) await writeFile(join(standaloneDirectory, filename), "binary");
	const manifestPath = join(root, "release-artifacts.json");
	writeReleaseArtifactManifest(manifestPath, records, { standaloneDirectory });
	return manifestPath;
}

async function runReleaseSbomCli(root, fakeNpmBody) {
	const manifestPath = await writeReleaseManifestFixture(root);
	const shimDirectory = join(root, "shim");
	await mkdir(shimDirectory, { recursive: true });
	await writeFile(join(shimDirectory, "npm"), `#!/usr/bin/env node\n${fakeNpmBody}\n`, { mode: 0o755 });
	const outDir = join(root, "out");
	const script = fileURLToPath(new URL("./generate-sbom.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [
		script,
		"--out-dir", outDir,
		"--release-manifest", manifestPath,
		"--install-directory", root,
	], { encoding: "utf8", env: { ...process.env, PATH: `${shimDirectory}:${process.env.PATH}` } });
	return { result, outPath: join(outDir, "sbom-release-artifacts.cyclonedx.json") };
}

test("release-mode SBOM refuses an empty npm response instead of writing it as evidence", { skip: posixShimOnly }, async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-sbom-release-empty-"));
	try {
		const { result, outPath } = await runReleaseSbomCli(root, 'process.stdout.write("{}");');
		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(`${result.stdout}${result.stderr}`, /no real dependency components/);
		assert.equal(existsSync(outPath), false, "a rejected SBOM must not be left on disk as release evidence");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("release-mode SBOM refuses malformed npm output instead of writing it as evidence", { skip: posixShimOnly }, async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-sbom-release-malformed-"));
	try {
		const { result, outPath } = await runReleaseSbomCli(root, 'process.stdout.write("not json at all");');
		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(`${result.stdout}${result.stderr}`, /did not produce valid JSON/);
		assert.equal(existsSync(outPath), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("release-mode SBOM writes a real component set and annotates it with the retained artifact identity", { skip: posixShimOnly }, async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-sbom-release-ok-"));
	try {
		const document = {
			bomFormat: "CycloneDX",
			specVersion: "1.5",
			components: [{ type: "library", name: "root", version: "1.0.0" }, { type: "library", name: "dep", version: "2.0.0" }],
		};
		const { result, outPath } = await runReleaseSbomCli(root, `process.stdout.write(${JSON.stringify(JSON.stringify(document))});`);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const written = JSON.parse(await readFile(outPath, "utf8"));
		assert.equal(written.components.length, 2);
		const names = written.metadata.properties.map((property) => property.name);
		assert.ok(names.includes("apex:release-artifact:apex-code:sha256"));
		assert.ok(names.includes("apex:release-artifact:apex-code-agent-core:integrity"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
