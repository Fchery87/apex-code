import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "../release-packages.mjs";
import {
	REQUIRED_STANDALONE_ARTIFACTS,
	checkAllOwnedPackages,
	checkPackedProductSurface,
	createReleaseArtifactRecord,
	readReleaseArtifactDocument,
	readReleaseArtifactManifest,
	verifyStandaloneArtifacts,
	writeReleaseArtifactManifest,
	installPackedTarballs,
	packToDirectory,
	releaseManifestGate,
	runPackedFunctionalSmoke,
} from "./packed-product-surface.mjs";

async function withTempDir(run) {
	const directory = await mkdtemp(join(tmpdir(), "apex-packed-surface-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("passes a clean packed directory with no violations", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n\nSome docs.\n");
		await mkdir(join(root, "dist"), { recursive: true });
		await writeFile(join(root, "dist", "cli.js"), "console.log('operating inside Apex Code');\n");

		assert.deepEqual(checkPackedProductSurface(root), []);
	});
});

test("catches active Pi product misidentification in compiled dist output", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n");
		await mkdir(join(root, "dist"), { recursive: true });
		await writeFile(join(root, "dist", "main.js"), "const message = 'operating inside pi';\n");

		const violations = checkPackedProductSurface(root);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].file, join("dist", "main.js"));
		assert.match(violations[0].reason, /claims the running product is Pi/);
	});
});

test("catches a doc link to upstream Pi source for a forked package", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n");
		await mkdir(join(root, "docs"), { recursive: true });
		await writeFile(
			join(root, "docs", "extensions.md"),
			"See https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md for tool source.\n",
		);

		const violations = checkPackedProductSurface(root);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].file, join("docs", "extensions.md"));
		assert.match(violations[0].reason, /forked \(not frozen\) package/);
	});
});

test("does not flag a doc link to upstream Pi source for a frozen package", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n");
		await mkdir(join(root, "docs"), { recursive: true });
		await writeFile(
			join(root, "docs", "custom-provider.md"),
			"See https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/providers.ts for the frozen provider interface.\n",
		);

		assert.deepEqual(checkPackedProductSurface(root), []);
	});
});

test("catches example code that spawns or names a nonexistent `pi` binary", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n");
		await mkdir(join(root, "docs"), { recursive: true });
		await writeFile(
			join(root, "docs", "containerization.md"),
			'```dockerfile\nFROM node:20\nENTRYPOINT ["pi"]\n```\n',
		);
		await writeFile(
			join(root, "docs", "rpc.md"),
			"```js\nconst child = spawn(\"pi\", [\"--mode\", \"rpc\"]);\n```\n",
		);

		const violations = checkPackedProductSurface(root);
		const reasons = violations.map((v) => v.reason).sort();
		assert.equal(violations.length, 2);
		assert.match(reasons[0], /ENTRYPOINT names a nonexistent `pi` binary/);
		assert.match(reasons[1], /spawns a nonexistent `pi` binary/);
	});
});

test("does not flag legitimate historical CHANGELOG.md entries mentioning old pi.dev/pi flags", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n");
		await writeFile(
			join(root, "CHANGELOG.md"),
			"# Changelog\n\n- Removed implicit `pi.dev` model-catalog fallback.\n- Fixed a bug where the agent would suggest restarting with `pi -ne`.\n",
		);

		assert.deepEqual(checkPackedProductSurface(root), []);
	});
});

test("catches a secret-shaped string in compiled dist output", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n");
		await mkdir(join(root, "dist"), { recursive: true });
		await writeFile(join(root, "dist", "config.js"), `const fallback = "sk-${"a".repeat(32)}";\n`);

		const violations = checkPackedProductSurface(root);
		assert.equal(violations.length, 1);
		assert.match(violations[0].reason, /API key/);
	});
});

test("catches a build-machine absolute path without flagging ordinary cross-platform path logic", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Apex Code\n");
		await mkdir(join(root, "dist"), { recursive: true });
		// Real shape found in this codebase's own export-html template: ordinary
		// generic path-prefix logic, never a leaked absolute path.
		await writeFile(
			join(root, "dist", "safe.js"),
			"function shortenPath(p) { if (p.startsWith('/Users/')) return '~'; if (p.startsWith('/home/')) return '~'; }\n",
		);
		await writeFile(
			join(root, "dist", "leaked.js"),
			"// built at /home/ci-builder/Documents/coding-agent/src/cli.ts\nexport const x = 1;\n",
		);

		const violations = checkPackedProductSurface(root);
		assert.equal(violations.length, 1);
		assert.equal(violations[0].file, join("dist", "leaked.js"));
		assert.match(violations[0].reason, /build-machine absolute path/);
	});
});

test("catches a packed README that does not identify Apex Code", async () => {
	await withTempDir(async (root) => {
		await writeFile(join(root, "README.md"), "# Pi\n\nOld branding.\n");
		await mkdir(join(root, "dist"), { recursive: true });
		await writeFile(join(root, "dist", "cli.js"), "console.log('hi');\n");

		const violations = checkPackedProductSurface(root);
		assert.equal(violations.length, 1);
		assert.match(violations[0].reason, /does not identify Apex Code/);
	});
});

// This test packs, installs from the real npm registry, and runs a real
// sandboxed turn -- real network access and ~20s, unlike every other test in
// this file. .github/workflows/release.yml already runs the equivalent check
// as its own required pre-publish step (node scripts/apex/packed-product-surface.mjs
// --smoke; see release-workflow.test.mjs's "gate runs before either publish
// step" test for that wiring), so this stays opt-in rather than adding real
// network dependency to every ordinary `npm test` run.
const bothOwnedPackagesAreBuilt = getPublicWorkspacePackages().every((pkg) => existsSync(join(pkg.directory, "dist")));
const smokeTestOptedIn = process.env.APEX_PACKED_SMOKE_TEST === "1";

test(
	"a clean scratch install of both real packed Apex tarballs completes a real turn (opt-in: APEX_PACKED_SMOKE_TEST=1, requires npm run build first)",
	{ skip: !smokeTestOptedIn || !bothOwnedPackagesAreBuilt, timeout: 120_000 },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "apex-packed-smoke-"));
		try {
			const report = checkAllOwnedPackages(root);
			for (const entry of report) {
				assert.deepEqual(entry.violations, [], `${entry.name}: ${JSON.stringify(entry.violations)}`);
			}

			const tarballsByName = Object.fromEntries(report.map((entry) => [entry.name, join(root, entry.filename)]));
			const installDirectory = join(root, "install");
			installPackedTarballs(tarballsByName, installDirectory);

			const smoke = runPackedFunctionalSmoke(installDirectory);
			assert.ok(smoke.ok, `smoke test failed (status ${smoke.status}):\n${smoke.stdout}\n${smoke.stderr}`);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("packToDirectory packs and extracts a real tarball for a synthetic package", async () => {
	await withTempDir(async (root) => {
		const packageDirectory = join(root, "pkg");
		await mkdir(packageDirectory, { recursive: true });
		await writeFile(
			join(packageDirectory, "package.json"),
			JSON.stringify({ name: "apex-packed-surface-fixture", version: "1.0.0", files: ["index.js"] }, null, "\t"),
		);
		await writeFile(join(packageDirectory, "index.js"), "console.log('operating inside Apex Code');\n");
		const destination = join(root, "out");

		const { extractedDirectory, packed } = packToDirectory(packageDirectory, destination);

		assert.equal(packed.name, "apex-packed-surface-fixture");
		const violations = checkPackedProductSurface(extractedDirectory, { requireApexReadme: false });
		assert.deepEqual(violations, []);
	});
});

test("clean packed installs resolve runtime dependencies from the package directory", async () => {
	await withTempDir(async (root) => {
		const packageDirectory = join(root, "pkg");
		await mkdir(packageDirectory, { recursive: true });
		await writeFile(
			join(packageDirectory, "package.json"),
			JSON.stringify({ name: "apex-packed-install-fixture", version: "1.0.0", dependencies: { chalk: "5.6.2" } }),
		);
		await writeFile(join(packageDirectory, "index.js"), "import chalk from 'chalk'; export const styled = chalk.green('ok');\n");
		const destination = join(root, "out");
		const { tarballPath } = packToDirectory(packageDirectory, destination);
		const installDirectory = join(root, "install");
		installPackedTarballs({ "apex-packed-install-fixture": tarballPath }, installDirectory);
		assert.equal(existsSync(join(installDirectory, "node_modules", "apex-packed-install-fixture")), true);
		assert.equal(existsSync(join(installDirectory, "node_modules", "apex-packed-install-fixture", "node_modules", "chalk")), true);
	});
});


test("release artifact record retains the packed bytes after the package directory mutates", async () => {
	await withTempDir(async (root) => {
		const outputDirectory = join(root, "out");
		const records = [];
		const testedBytesByName = {};
		for (const [name, marker] of [["apex-code-agent-core", "core"], ["apex-code", "cli"]]) {
			const packageDirectory = join(root, name.replace(/[^a-z]/g, ""));
			await mkdir(packageDirectory, { recursive: true });
			await writeFile(
				join(packageDirectory, "package.json"),
				JSON.stringify({ name, version: "1.2.3", files: ["index.js"] }),
			);
			await writeFile(join(packageDirectory, "index.js"), `export const identity = '${marker}';\n`);

			const { tarballPath, packed } = packToDirectory(packageDirectory, outputDirectory);
			const record = createReleaseArtifactRecord({
				tarballPath,
				packed,
				expectedGitCommit: "0123456789abcdef0123456789abcdef01234567",
				workflowIdentity: "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v1.2.3",
			});
			testedBytesByName[name] = await readFile(tarballPath);
			records.push(record);

			await writeFile(join(packageDirectory, "index.js"), `export const identity = 'mutated-${marker}';\n`);
			assert.deepEqual(await readFile(record.tarballPath), testedBytesByName[name]);
			assert.equal(record.sha256, createHash("sha256").update(testedBytesByName[name]).digest("hex"));
			assert.equal(record.integrity, `sha512-${createHash("sha512").update(testedBytesByName[name]).digest("base64")}`);
			assert.equal(record.provenanceSubject.name, `pkg:npm/${name}@1.2.3`);
			assert.equal(record.provenanceSubject.digest.sha512, createHash("sha512").update(testedBytesByName[name]).digest("hex"));
		}

		const standaloneDirectory = join(outputDirectory, "standalone");
		await mkdir(standaloneDirectory, { recursive: true });
		for (const filename of REQUIRED_STANDALONE_ARTIFACTS) await writeFile(join(standaloneDirectory, filename), "binary");
		const manifestPath = join(outputDirectory, "release-artifacts.json");
		writeReleaseArtifactManifest(manifestPath, records, { standaloneDirectory });
		const readRecords = readReleaseArtifactManifest(manifestPath);
		for (const record of records) {
			assert.deepEqual(readRecords.find((entry) => entry.packageName === record.packageName), record);
		}
	});
});


test("release artifact document binds all six standalone archives to the package identity", async () => {
	await withTempDir(async (root) => {
		const tarballPaths = [];
		for (const [index, name] of ["apex-code-agent-core", "apex-code"].entries()) {
			const tarballPath = join(root, `pkg-${index}.tgz`);
			await writeFile(tarballPath, `package-${index}`);
			tarballPaths.push({ tarballPath, name });
		}
		const records = tarballPaths.map(({ tarballPath, name }) => createReleaseArtifactRecord({
			tarballPath,
			packed: { name, version: "1.0.0" },
			expectedGitCommit: "0123456789abcdef0123456789abcdef01234567",
			workflowIdentity: "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v1.2.3",
		}));
		const standaloneDirectory = join(root, "standalone");
		await mkdir(standaloneDirectory);
		const standaloneBytes = {};
		for (const [index, filename] of REQUIRED_STANDALONE_ARTIFACTS.entries()) {
			standaloneBytes[filename] = `binary-${index}`;
			await writeFile(join(standaloneDirectory, filename), standaloneBytes[filename]);
		}
		const manifestPath = join(root, "manifest.json");
		writeReleaseArtifactManifest(manifestPath, records, { standaloneDirectory });
		const document = readReleaseArtifactDocument(manifestPath);
		assert.equal(document.releaseIdentity.expectedGitCommit, "0123456789abcdef0123456789abcdef01234567");
		assert.equal(document.releaseIdentity.workflowIdentity, "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v1.2.3");
		assert.deepEqual(document.standaloneArtifacts.map((entry) => entry.filename), REQUIRED_STANDALONE_ARTIFACTS);
		for (const entry of document.standaloneArtifacts) {
			assert.equal(entry.sha256, createHash("sha256").update(standaloneBytes[entry.filename]).digest("hex"));
		}
		assert.deepEqual(verifyStandaloneArtifacts(document, standaloneDirectory), []);
		const mutated = REQUIRED_STANDALONE_ARTIFACTS[2];
		await writeFile(join(standaloneDirectory, mutated), "changed");
		assert.match(verifyStandaloneArtifacts(document, standaloneDirectory).join("\n"), new RegExp(`${mutated}: .*does not match release artifact record`));
	});
});

test("manifest writer and reader reject anything but exactly the two owned packages and six standalone archives", async () => {
	await withTempDir(async (root) => {
		const tarballPath = join(root, "pkg.tgz");
		await writeFile(tarballPath, "package");
		const recordFor = (name) => createReleaseArtifactRecord({
			tarballPath,
			packed: { name, version: "1.0.0" },
			expectedGitCommit: "0123456789abcdef0123456789abcdef01234567",
			workflowIdentity: "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v1.2.3",
		});
		const both = ["apex-code-agent-core", "apex-code"].map(recordFor);
		const standaloneDirectory = join(root, "standalone");
		await mkdir(standaloneDirectory);
		for (const filename of REQUIRED_STANDALONE_ARTIFACTS) await writeFile(join(standaloneDirectory, filename), "binary");

		assert.throws(() => writeReleaseArtifactManifest(join(root, "one.json"), [both[0]], { standaloneDirectory }), /exactly apex-code-agent-core and apex-code/);
		assert.throws(() => writeReleaseArtifactManifest(join(root, "three.json"), [...both, recordFor("extra")], { standaloneDirectory }), /exactly apex-code-agent-core and apex-code/);
		const manifestPath = join(root, "complete.json");
		writeReleaseArtifactManifest(manifestPath, both, { standaloneDirectory });

		const incomplete = JSON.parse(await readFile(manifestPath, "utf8"));
		incomplete.standaloneArtifacts = incomplete.standaloneArtifacts.slice(0, 5);
		const incompletePath = join(root, "five.json");
		await writeFile(incompletePath, JSON.stringify(incomplete));
		assert.throws(() => readReleaseArtifactDocument(incompletePath), /six required standalone archives/);

		const duplicated = JSON.parse(await readFile(manifestPath, "utf8"));
		duplicated.standaloneArtifacts[1] = { ...duplicated.standaloneArtifacts[0] };
		const duplicatedPath = join(root, "duplicate.json");
		await writeFile(duplicatedPath, JSON.stringify(duplicated));
		assert.throws(() => readReleaseArtifactDocument(duplicatedPath), /six required standalone archives/);

		const drifted = JSON.parse(await readFile(manifestPath, "utf8"));
		drifted.releaseIdentity.expectedGitCommit = "ffffffffffffffffffffffffffffffffffffffff";
		const driftedPath = join(root, "drifted.json");
		await writeFile(driftedPath, JSON.stringify(drifted));
		assert.throws(() => readReleaseArtifactDocument(driftedPath), /does not match package records/);
	});
});


// RI-B10: the release publishes the retained *tarball file*, and npm only
// injects `gitHead` on the `publish <directory>` path (@npmcli/package-json's
// prepareSteps). A packed tarball therefore carries no directory-side commit,
// so the registry copy will not have one either. This is the live offline
// fixture that keeps that premise honest rather than asserted in prose.
test("a real packed tarball built inside a git repository carries no gitHead", async () => {
	await withTempDir(async (root) => {
		const packageDirectory = join(root, "pkg");
		await mkdir(packageDirectory, { recursive: true });
		await writeFile(
			join(packageDirectory, "package.json"),
			JSON.stringify({ name: "apex-githead-fixture", version: "1.0.0", license: "MIT", files: ["index.js"] }, null, "\t"),
		);
		await writeFile(join(packageDirectory, "index.js"), "export const identity = 'fixture';\n");
		execFileSync("git", ["init", "--quiet", "."], { cwd: packageDirectory });
		execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: packageDirectory });
		execFileSync("git", ["config", "user.name", "fixture"], { cwd: packageDirectory });
		execFileSync("git", ["add", "-A"], { cwd: packageDirectory });
		execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: packageDirectory });
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageDirectory, encoding: "utf8" }).trim();
		assert.match(head, /^[0-9a-f]{40}$/);

		const { extractedDirectory } = packToDirectory(packageDirectory, join(root, "out"));
		const packedManifest = JSON.parse(await readFile(join(extractedDirectory, "package.json"), "utf8"));
		assert.equal(
			packedManifest.gitHead,
			undefined,
			"npm pack must not bake a gitHead into the tarball -- the whole registry-gitHead expectation depends on this",
		);
	});
});


// RI-B5: the manifest used to be written before the smoke install ran, so a
// failed smoke left a digest-valid, publishable release record behind that
// publish-release-artifact.mjs would happily consume. One gate now decides,
// and it refuses to produce a publishable record without a passing smoke.
test("no publishable release record exists unless the functional smoke actually passed", () => {
	assert.deepEqual(releaseManifestGate({ manifestOut: undefined, smokeRequested: true, smokeOk: true, identityFailed: false }), { write: false });

	const noSmokeRequested = releaseManifestGate({ manifestOut: "m.json", smokeRequested: false, smokeOk: false, identityFailed: false });
	assert.equal(noSmokeRequested.write, false);
	assert.match(noSmokeRequested.error, /requires --smoke/);

	const identityFailed = releaseManifestGate({ manifestOut: "m.json", smokeRequested: true, smokeOk: true, identityFailed: true });
	assert.equal(identityFailed.write, false);
	assert.match(identityFailed.error, /identity check failed/);

	const smokeFailed = releaseManifestGate({ manifestOut: "m.json", smokeRequested: true, smokeOk: false, identityFailed: false });
	assert.equal(smokeFailed.write, false);
	assert.match(smokeFailed.error, /functional smoke/);

	assert.deepEqual(releaseManifestGate({ manifestOut: "m.json", smokeRequested: true, smokeOk: true, identityFailed: false }), { write: true });
});

test("the CLI refuses to produce a publishable record without running the smoke at all", async () => {
	await withTempDir(async (root) => {
		const manifestOut = join(root, "release-artifacts.json");
		const script = fileURLToPath(new URL("./packed-product-surface.mjs", import.meta.url));
		const result = spawnSync(process.execPath, [
			script,
			"--out", join(root, "out"),
			"--git-head", "0123456789abcdef0123456789abcdef01234567",
			"--workflow-identity", "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v1.2.3",
			"--manifest-out", manifestOut,
		], { encoding: "utf8" });
		assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(`${result.stdout}${result.stderr}`, /requires --smoke/);
		assert.equal(existsSync(manifestOut), false, "a release record must not exist without a passing smoke");
	});
});
