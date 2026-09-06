import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	checkDownloadedArtifact,
	checkPublishedMetadata,
	checkVerifiedProvenance,
	runNpmProvenanceVerification,
	checkTarballHash,
	decodeProvenanceStatement,
	fetchPublishedMetadata,
	hashTarball,
	verifyPublishedPackage,
} from "./verify-published-release.mjs";
import { createReleaseArtifactRecord, REQUIRED_STANDALONE_ARTIFACTS, writeReleaseArtifactManifest } from "./packed-product-surface.mjs";
import {
	buildProvenanceStatement,
	buildVerifiedPackage,
	SLSA_PROVENANCE_PREDICATE_TYPE,
} from "./fixtures/npm-attestation-bundles.mjs";

function fixtureMetadata(overrides = {}) {
	return {
		gitHead: "abc123",
		dist: {
			shasum: "shasum-value",
			integrity: "sha512-integrity-value",
			tarball: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
			attestations: {
				url: "https://registry.npmjs.org/-/npm/v1/attestations/example@1.0.0",
				provenance: { predicateType: "https://slsa.dev/provenance/v1" },
			},
		},
		...overrides,
	};
}

test("checkPublishedMetadata passes when gitHead matches and provenance is attached", () => {
	const problems = checkPublishedMetadata(fixtureMetadata(), { gitHead: "abc123" });
	assert.deepEqual(problems, []);
});

test("checkPublishedMetadata catches a gitHead mismatch", () => {
	const problems = checkPublishedMetadata(fixtureMetadata({ gitHead: "different" }), { gitHead: "abc123" });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /gitHead mismatch/);
});

// RI-B10. Publication hands `npm publish` the retained *tarball file*, and npm
// only injects `gitHead` on the `publish <directory>` path. The registry copy
// of an Apex release therefore has no gitHead at all, and demanding one made
// post-publication verification fail unconditionally on both packages. The
// commit binding now comes from the signed provenance statement instead
// (checkVerifiedProvenance's resolved gitCommit), which is strictly stronger
// than unsigned registry metadata. A gitHead that *is* present must still
// agree, so a directory-published package is not silently downgraded.
test("checkPublishedMetadata accepts absent gitHead, because a packed-tarball publish never records one", () => {
	const problems = checkPublishedMetadata(fixtureMetadata({ gitHead: undefined }), { gitHead: "abc123" });
	assert.deepEqual(problems, []);
});

test("checkPublishedMetadata still rejects a gitHead that is present but disagrees", () => {
	const problems = checkPublishedMetadata(fixtureMetadata({ gitHead: "deadbeef" }), { gitHead: "abc123" });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /gitHead mismatch/);
});

test("checkPublishedMetadata catches missing npm provenance", () => {
	const problems = checkPublishedMetadata(fixtureMetadata({ dist: { ...fixtureMetadata().dist, attestations: undefined } }), {
		gitHead: "abc123",
	});
	assert.equal(problems.length, 1);
	assert.match(problems[0], /no npm provenance attestation/);
});

test("checkPublishedMetadata catches an unexpected provenance predicate type", () => {
	const metadata = fixtureMetadata();
	metadata.dist.attestations.provenance.predicateType = "https://example.invalid/not-slsa";
	const problems = checkPublishedMetadata(metadata, { gitHead: "abc123" });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /unexpected provenance predicate type/);
});

test("checkTarballHash catches a shasum mismatch between registry metadata and downloaded bytes", () => {
	const problems = checkTarballHash(fixtureMetadata(), { shasum: "different-shasum", integrity: "sha512-integrity-value" });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /sha1.*does not match/);
});

test("checkTarballHash catches an integrity mismatch between registry metadata and downloaded bytes", () => {
	const problems = checkTarballHash(fixtureMetadata(), { shasum: "shasum-value", integrity: "sha512-different" });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /integrity.*does not match/);
});

test("checkTarballHash passes when both digests match", () => {
	const problems = checkTarballHash(fixtureMetadata(), { shasum: "shasum-value", integrity: "sha512-integrity-value" });
	assert.deepEqual(problems, []);
});

const registryTestsOptedIn = process.env.APEX_RELEASE_REGISTRY_TEST === "1";

// Real network calls against an already-published, real package
// (@earendil-works/pi-ai, a frozen upstream dependency this repo already
// consumes -- never one of Apex's own packages) to prove the registry-metadata
// shape assumptions and the hash-comparison logic hold against the real npm
// registry, not just a fixture shaped by hand.
test("fetchPublishedMetadata and hashTarball work against a real, already-published package", { skip: !registryTestsOptedIn }, async () => {
	const metadata = await fetchPublishedMetadata("@earendil-works/pi-ai", "0.84.1");
	assert.equal(metadata.gitHead, "53fa77ccd8a279eb87e92294ef3687b03ff80112");
	assert.ok(metadata.dist?.attestations?.url, "expected this real package to carry npm provenance");

	const hashes = await hashTarball(metadata.dist.tarball);
	assert.equal(hashes.shasum, metadata.dist.shasum);
	assert.equal(hashes.integrity, metadata.dist.integrity);
});

test("verifyPublishedPackage passes end to end for a real, already-published package with the right gitHead", { skip: !registryTestsOptedIn }, async () => {
	const { problems } = await verifyPublishedPackage("@earendil-works/pi-ai", "0.84.1", {
		gitHead: "53fa77ccd8a279eb87e92294ef3687b03ff80112",
	});
	assert.deepEqual(problems, []);
});

test("verifyPublishedPackage reports a gitHead mismatch for a real package with the wrong expected commit", { skip: !registryTestsOptedIn }, async () => {
	const { problems } = await verifyPublishedPackage("@earendil-works/pi-ai", "0.84.1", {
		gitHead: "0000000000000000000000000000000000000000",
	});
	assert.equal(problems.length, 1);
	assert.match(problems[0], /gitHead mismatch/);
});


/**
 * A fake `npm` on PATH plus a loopback tarball server: no registry traffic, no
 * real npm process, no credentials. RI-B2: both CLI end-to-end cases used to
 * sit behind APEX_RELEASE_REGISTRY_TEST=1 despite being fully offline, so the
 * default suite never covered the CLI's manifest wiring -- and the first run
 * with the flag set showed both cases broken (a `tarballServer is not defined`
 * ReferenceError, and a fake npm whose shebang the shim generator had
 * overwritten). They run unconditionally now.
 *
 * The signed-provenance response uses the real npm 11.19.0 raw bundle shape,
 * and the registry metadata deliberately carries no `gitHead`, matching what a
 * packed-tarball publish actually produces (RI-B10).
 */
async function writeNpmShim(directory, config) {
	await mkdir(directory, { recursive: true });
	const configPath = join(directory, "shim-config.json");
	await writeFile(configPath, JSON.stringify(config, null, "\t"));
	const shim = [
		"#!/usr/bin/env node",
		'const fs = require("node:fs");',
		'const crypto = require("node:crypto");',
		`const config = require(${JSON.stringify(configPath)});`,
		"const args = process.argv.slice(2);",
		'fs.appendFileSync(config.logPath, JSON.stringify(args) + "\\n");',
		'if (args[0] === "--version") { process.stdout.write(config.npmVersion); process.exit(0); }',
		"const artifacts = require(config.manifestPath).artifacts;",
		'if (args[0] === "view") {',
		"\tconst spec = args[1];",
		'\tconst name = spec.slice(0, spec.lastIndexOf("@"));',
		"\tconst record = artifacts.find((entry) => entry.packageName === name);",
		"\tconst bytes = config.substitution === null",
		"\t\t? fs.readFileSync(record.tarballPath)",
		'\t\t: Buffer.from(config.substitution, "utf8");',
		"\tprocess.stdout.write(JSON.stringify({ dist: {",
		'\t\tshasum: crypto.createHash("sha1").update(bytes).digest("hex"),',
		'\t\tintegrity: "sha512-" + crypto.createHash("sha512").update(bytes).digest("base64"),',
		'\t\ttarball: "http://127.0.0.1:" + config.tarballPort + "/example.tgz?name=" + encodeURIComponent(name),',
		"\t\tattestations: {",
		'\t\t\turl: "https://registry.npmjs.org/-/npm/v1/attestations/" + name,',
		'\t\t\tprovenance: { predicateType: "https://slsa.dev/provenance/v1" },',
		"\t\t},",
		"\t} }));",
		"\tprocess.exit(0);",
		"}",
		'if (args[0] === "audit") {',
		"\tprocess.stdout.write(JSON.stringify({ invalid: [], missing: [], verified: config.verified }));",
		"\tprocess.exit(0);",
		"}",
		"process.exit(1);",
		"",
	].join("\n");
	await writeFile(join(directory, "npm"), shim, { mode: 0o755 });
	// The shebang has to survive: an earlier version of this shim prepended a
	// prelude ahead of it, so /bin/sh ran the file and every case failed with
	// `Syntax error: "(" unexpected` instead of testing anything.
	assert.ok(shim.startsWith("#!/usr/bin/env node\n"));
	return directory;
}

async function withReleaseFixture(prefix, run) {
	const root = await mkdtemp(join(tmpdir(), prefix));
	let server;
	try {
		const identity = {
			expectedGitCommit: "0123456789abcdef0123456789abcdef01234567",
			workflowIdentity: "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v1.2.3",
		};
		const packageBytes = {};
		const records = [];
		for (const [index, name] of ["apex-code-agent-core", "apex-code"].entries()) {
			const tarballPath = join(root, `pkg-${index}.tgz`);
			packageBytes[name] = `tested-bytes-${index}`;
			await writeFile(tarballPath, packageBytes[name]);
			records.push(createReleaseArtifactRecord({ tarballPath, packed: { name, version: "1.2.3" }, ...identity }));
		}
		const standaloneDirectory = join(root, "standalone");
		await mkdir(standaloneDirectory);
		for (const filename of REQUIRED_STANDALONE_ARTIFACTS) await writeFile(join(standaloneDirectory, filename), `binary-${filename}`);
		const manifestPath = join(root, "release-artifacts.json");
		writeReleaseArtifactManifest(manifestPath, records, { standaloneDirectory });

		await run({
			root,
			identity,
			records,
			packageBytes,
			manifestPath,
			async serve(bytesForName) {
				server = createServer((request, response) => {
					const name = new URL(request.url, "http://loopback").searchParams.get("name");
					response.end(bytesForName(name));
				});
				await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
				return server.address().port;
			},
			// Asynchronous on purpose: the tarball is served from this process's
			// own loopback server, and spawnSync would block the event loop that
			// has to answer the verifier's fetch -- a deadlock, not a test.
			runCli(shimDirectory, manifestOut) {
				return new Promise((resolveResult) => {
					const child = spawn(
						process.execPath,
						[
							fileURLToPath(new URL("./verify-published-release.mjs", import.meta.url)),
							"--release-manifest", manifestPath,
							"--install-directory", join(root, "install"),
							"--manifest-out", manifestOut,
						],
						{ env: { ...process.env, PATH: `${shimDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` } },
					);
					let stdout = "";
					let stderr = "";
					child.stdout.setEncoding("utf8");
					child.stderr.setEncoding("utf8");
					child.stdout.on("data", (chunk) => { stdout += chunk; });
					child.stderr.on("data", (chunk) => { stderr += chunk; });
					child.on("close", (status) => resolveResult({ status, stdout, stderr }));
				});
			},
		});
	} finally {
		// The verifier's fetch keeps its socket alive, so a bare close() never
		// settles and the whole test file hangs instead of reporting.
		server?.closeAllConnections();
		server?.close();
		await rm(root, { recursive: true, force: true });
	}
}

function verifiedFor(records, identity, overrides = {}) {
	return records.map((record) => buildVerifiedPackage({
		name: record.packageName,
		version: record.version,
		identity: {
			subjectName: record.provenanceSubject.name,
			subjectSha512: record.provenanceSubject.digest.sha512,
			repository: "https://github.com/Fchery87/apex-code",
			workflowPath: ".github/workflows/release.yml",
			workflowRef: "refs/tags/v1.2.3",
			gitCommit: identity.expectedGitCommit,
			...overrides,
		},
	}));
}

test("CLI verifies a manifest-shaped release end to end through fake npm and loopback tarball bytes", async () => {
	await withReleaseFixture("apex-verify-manifest-", async (fixture) => {
		const tarballPort = await fixture.serve((name) => fixture.packageBytes[name]);
		const logPath = join(fixture.root, "args.jsonl");
		await writeFile(logPath, "");
		const shimDirectory = await writeNpmShim(join(fixture.root, "shim"), {
			logPath,
			npmVersion: "11.19.0",
			manifestPath: fixture.manifestPath,
			tarballPort,
			substitution: null,
			verified: verifiedFor(fixture.records, fixture.identity),
		});
		await mkdir(join(fixture.root, "install"));

		const manifestOut = join(fixture.root, "release-evidence.json");
		const result = await fixture.runCli(shimDirectory, manifestOut);
		assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

		const invocations = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(invocations[0], ["--version"]);
		assert.deepEqual(invocations[1], ["audit", "signatures", "--json", "--include-attestations", "--ignore-scripts"]);
		assert.ok(invocations.some((call) => call[0] === "view" && call[1] === "apex-code-agent-core@1.2.3"));
		assert.ok(invocations.some((call) => call[0] === "view" && call[1] === "apex-code@1.2.3"));

		const evidence = JSON.parse(await readFile(manifestOut, "utf8"));
		assert.equal(evidence.packages.length, 2);
		for (const entry of evidence.packages) {
			assert.equal(entry.verified, true, `${entry.packageName}: ${JSON.stringify(entry.problems)}`);
			assert.equal(entry.downloadedSha256, createHash("sha256").update(fixture.packageBytes[entry.packageName]).digest("hex"));
		}
	});
});

test("CLI fails closed when the registry serves bytes that differ from the retained manifest digest", async () => {
	await withReleaseFixture("apex-verify-substituted-", async (fixture) => {
		const tarballPort = await fixture.serve(() => "substituted-bytes");
		const logPath = join(fixture.root, "args.jsonl");
		await writeFile(logPath, "");
		const shimDirectory = await writeNpmShim(join(fixture.root, "shim"), {
			logPath,
			npmVersion: "11.19.0",
			manifestPath: fixture.manifestPath,
			tarballPort,
			// Registry metadata that is internally consistent with the substituted
			// bytes: only the retained local digest catches this.
			substitution: "substituted-bytes",
			verified: verifiedFor(fixture.records, fixture.identity),
		});
		await mkdir(join(fixture.root, "install"));

		const result = await fixture.runCli(shimDirectory, join(fixture.root, "evidence.json"));
		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(`${result.stdout}${result.stderr}`, /does not match retained local sha256/);
	});
});

test("CLI fails closed when the signed provenance names a different workflow than the release", async () => {
	await withReleaseFixture("apex-verify-workflow-", async (fixture) => {
		const tarballPort = await fixture.serve((name) => fixture.packageBytes[name]);
		const logPath = join(fixture.root, "args.jsonl");
		await writeFile(logPath, "");
		const shimDirectory = await writeNpmShim(join(fixture.root, "shim"), {
			logPath,
			npmVersion: "11.19.0",
			manifestPath: fixture.manifestPath,
			tarballPort,
			substitution: null,
			verified: verifiedFor(fixture.records, fixture.identity, { workflowPath: ".github/workflows/attacker.yml" }),
		});
		await mkdir(join(fixture.root, "install"));

		const result = await fixture.runCli(shimDirectory, join(fixture.root, "evidence.json"));
		assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
		assert.match(`${result.stdout}${result.stderr}`, /workflow identity/);
	});
});


test("downloaded bytes must match the retained local digest even when registry metadata is self-consistent", () => {
	const localBytes = Buffer.from("tested artifact");
	const substitutedBytes = Buffer.from("registry substitution");
	const metadata = fixtureMetadata({
		dist: {
			...fixtureMetadata().dist,
			shasum: createHash("sha1").update(substitutedBytes).digest("hex"),
			integrity: `sha512-${createHash("sha512").update(substitutedBytes).digest("base64")}`,
		},
	});
	const actualHashes = {
		sha1: createHash("sha1").update(substitutedBytes).digest("hex"),
		sha256: createHash("sha256").update(substitutedBytes).digest("hex"),
		sha512: createHash("sha512").update(substitutedBytes).digest("hex"),
		integrity: `sha512-${createHash("sha512").update(substitutedBytes).digest("base64")}`,
	};

	assert.deepEqual(checkTarballHash(metadata, { shasum: actualHashes.sha1, integrity: actualHashes.integrity }), []);
	const problems = checkDownloadedArtifact(actualHashes, {
		sha256: createHash("sha256").update(localBytes).digest("hex"),
		integrity: `sha512-${createHash("sha512").update(localBytes).digest("base64")}`,
	});
	assert.equal(problems.length, 2);
	assert.match(problems[0], /retained local sha256/);
});

test("signed provenance decodes npm 11.19 raw DSSE bundle payload", () => {
	const expected = {
		provenanceSubject: { name: "pkg:npm/apex-code@1.2.3", digest: { sha512: "abcd" } },
		workflowIdentity: "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v1.2.3",
		expectedGitCommit: "abc123",
	};
	const statement = {
		subject: [{ name: "pkg:npm/apex-code@1.2.3", digest: { sha512: "abcd" } }],
		predicate: { buildDefinition: { externalParameters: { workflow: { ref: "refs/tags/v1.2.3", repository: "https://github.com/Fchery87/apex-code", path: ".github/workflows/release.yml" } }, resolvedDependencies: [{ digest: { gitCommit: "abc123" } }] } },
	};
	const verified = {
		name: "apex-code",
		version: "1.2.3",
		attestationBundles: [{
			predicateType: "https://slsa.dev/provenance/v1",
			bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64") } },
		}],
	};
	assert.deepEqual(checkVerifiedProvenance(verified, expected), []);
});

test("signed provenance must match the retained subject digest and workflow identity", () => {
	const expected = {
		provenanceSubject: { name: "pkg:npm/apex-code@1.2.3", digest: { sha512: "abcd" } },
		workflowIdentity: "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v1.2.3",
		expectedGitCommit: "abc123",
	};
	const verified = {
		name: "apex-code",
		version: "1.2.3",
		attestationBundles: [{
			predicateType: "https://slsa.dev/provenance/v1",
			bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify({
				subject: [{ name: "pkg:npm/apex-code@1.2.3", digest: { sha512: "abcd" } }],
				predicate: { buildDefinition: { externalParameters: { workflow: { ref: "refs/tags/v1.2.3", repository: "https://github.com/Fchery87/apex-code", path: ".github/workflows/release.yml" } }, resolvedDependencies: [{ digest: { gitCommit: "abc123" } }] } },
			}), "utf8").toString("base64") } },
		}],
	};
	assert.deepEqual(checkVerifiedProvenance(verified, expected), []);
	const decode = () => JSON.parse(Buffer.from(verified.attestationBundles[0].bundle.dsseEnvelope.payload, "base64"));
	const changedSubject = structuredClone(verified);
	const subjectStatement = decode(); subjectStatement.subject[0].digest.sha512 = "different";
	changedSubject.attestationBundles[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(subjectStatement)).toString("base64");
	assert.match(checkVerifiedProvenance(changedSubject, expected).join("\n"), /subject digest/);
	const changedWorkflow = structuredClone(verified);
	const workflowStatement = decode(); workflowStatement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml";
	changedWorkflow.attestationBundles[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(workflowStatement)).toString("base64");
	assert.match(checkVerifiedProvenance(changedWorkflow, expected).join("\n"), /workflow identity/);
});

test("signed provenance controls fail closed on malformed, missing, or wrong payloads", () => {
	const expected = {
		provenanceSubject: { name: "pkg:npm/apex-code@1.2.3", digest: { sha512: "abcd" } },
		workflowIdentity: "https://github.com/Fchery87/apex-code/.github/workflows/release.yml@refs/tags/v1.2.3",
		expectedGitCommit: "abc123",
	};
	const verifiedPackage = (payloadBase64) => ({
		name: "apex-code",
		version: "1.2.3",
		attestationBundles: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: payloadBase64 } } }],
	});
	const encode = (statement) => Buffer.from(JSON.stringify(statement), "utf8").toString("base64");

	assert.match(checkVerifiedProvenance(verifiedPackage(undefined), expected).join("\n"), /no decodable signed SLSA provenance statement payload/);
	assert.match(checkVerifiedProvenance(verifiedPackage(""), expected).join("\n"), /no decodable signed SLSA provenance statement payload/);
	assert.match(checkVerifiedProvenance(verifiedPackage(Buffer.from("not json", "utf8").toString("base64")), expected).join("\n"), /no decodable/);
	assert.match(checkVerifiedProvenance(verifiedPackage(encode({ noSubject: true })), expected).join("\n"), /no decodable/);
	assert.match(checkVerifiedProvenance(verifiedPackage(encode({ subject: [], predicate: {} })), expected).join("\n"), /no decodable/);
	const noSubjectName = encode({ subject: [{ name: "pkg:npm/other@1.2.3", digest: { sha512: "abcd" } }], predicate: { buildDefinition: { externalParameters: { workflow: { ref: "refs/tags/v1.2.3", repository: "https://github.com/Fchery87/apex-code", path: ".github/workflows/release.yml" } }, resolvedDependencies: [{ digest: { gitCommit: "abc123" } }] } } });
	assert.match(checkVerifiedProvenance(verifiedPackage(noSubjectName), expected).join("\n"), /no subject named/);
	const wrongCommit = encode({ subject: [{ name: "pkg:npm/apex-code@1.2.3", digest: { sha512: "abcd" } }], predicate: { buildDefinition: { externalParameters: { workflow: { ref: "refs/tags/v1.2.3", repository: "https://github.com/Fchery87/apex-code", path: ".github/workflows/release.yml" } }, resolvedDependencies: [{ digest: { gitCommit: "ffffffff" } }] } } });
	assert.match(checkVerifiedProvenance(verifiedPackage(wrongCommit), expected).join("\n"), /does not resolve expected git commit/);
	const noProvenanceEntry = { name: "apex-code", version: "1.2.3", attestationBundles: [{ predicateType: "https://example.invalid/other", bundle: {} }] };
	assert.match(checkVerifiedProvenance(noProvenanceEntry, expected).join("\n"), /no decodable signed SLSA provenance statement payload/);
	assert.equal(decodeProvenanceStatement({}), undefined);
	assert.equal(decodeProvenanceStatement({ dsseEnvelope: { payload: 42 } }), undefined);
});

test("npm provenance verification invokes the pinned official CLI offline and parses its signed result", async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-npm-provenance-"));
	try {
		const logPath = join(root, "args.json");
		const fakeNpm = join(root, "npm");
		const officialOutput = JSON.stringify({
			invalid: [],
			missing: [],
			verified: [buildVerifiedPackage({ name: "apex-code", version: "1.2.3", identity: REALISTIC_IDENTITY })],
		});
		await writeFile(
			fakeNpm,
			`#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(officialOutput)});\n`,
			{ mode: 0o755 },
		);
		const installDirectory = join(root, "install");
		await mkdir(installDirectory);
		const result = runNpmProvenanceVerification({
			npmExecutable: fakeNpm,
			npmVersion: "11.19.0",
			installDirectory,
		});
		assert.deepEqual(await readFile(logPath, "utf8").then(JSON.parse), [
			"audit", "signatures", "--json", "--include-attestations", "--ignore-scripts",
		]);
		assert.equal(result.verified[0].name, "apex-code");
		// The parsed result must still be usable by the real provenance check --
		// the point of RI-B1 is that this hand-off was to a field npm never sends.
		assert.deepEqual(checkVerifiedProvenance(result.verified[0], REALISTIC_EXPECTED), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("npm provenance verification rejects an unpinned npm version", () => {
	assert.throws(
		() => runNpmProvenanceVerification({ npmExecutable: "npm", npmVersion: "11.18.0", installDirectory: "." }),
		/requires npm 11\.19\.0/,
	);
});


test("npm provenance verification rejects an official invalid-attestation result", async () => {
	const root = await mkdtemp(join(tmpdir(), "apex-invalid-provenance-"));
	try {
		const fakeNpm = join(root, "npm");
		await writeFile(fakeNpm, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ invalid: [{ code: "EATTESTATIONVERIFY" }], missing: [], verified: [] }));\n', { mode: 0o755 });
		assert.throws(
			() => runNpmProvenanceVerification({ npmExecutable: fakeNpm, npmVersion: "11.19.0", installDirectory: root }),
			/rejected package signatures or attestations/,
		);
	} finally { await rm(root, { recursive: true, force: true }); }
});


// RI-B1. The verifier used to read `attestationBundles[].statement`, a field
// npm never emits. Reading the pinned npm 11.19.0 source settles the real
// shape: pacote decodes bundle.dsseEnvelope.payload into a *local* `statement`
// variable, then assigns `mani._attestationBundles = attestations` -- the raw
// registry array of `{ predicateType, bundle }` -- which verify-signatures.js
// hands straight to `verified[].attestationBundles`. See
// scripts/apex/fixtures/npm-attestation-bundles.mjs for the citation.
const REALISTIC_IDENTITY = {
	subjectName: "pkg:npm/apex-code@1.2.3",
	subjectSha512: "e".repeat(128),
	repository: "https://github.com/Fchery87/apex-code",
	workflowPath: ".github/workflows/release.yml",
	workflowRef: "refs/tags/v1.2.3",
	gitCommit: "0123456789abcdef0123456789abcdef01234567",
};

const REALISTIC_EXPECTED = {
	provenanceSubject: { name: REALISTIC_IDENTITY.subjectName, digest: { sha512: REALISTIC_IDENTITY.subjectSha512 } },
	workflowIdentity: `${REALISTIC_IDENTITY.repository}/${REALISTIC_IDENTITY.workflowPath}@${REALISTIC_IDENTITY.workflowRef}`,
	expectedGitCommit: REALISTIC_IDENTITY.gitCommit,
};

test("checkVerifiedProvenance accepts npm 11.19.0's real raw attestation-bundle shape", () => {
	const verified = buildVerifiedPackage({ name: "apex-code", version: "1.2.3", identity: REALISTIC_IDENTITY });

	// Guard the fixture itself against drifting back to the invented shape.
	assert.equal(verified.attestationBundles.length, 2, "real npm output carries the publish attestation alongside provenance");
	for (const entry of verified.attestationBundles) {
		assert.equal(entry.statement, undefined, "npm never exposes a decoded `statement` on an attestation bundle");
		assert.equal(typeof entry.bundle.dsseEnvelope.payload, "string");
		assert.equal(entry.bundle.dsseEnvelope.payloadType, "application/vnd.in-toto+json");
		assert.equal(typeof entry.bundle.dsseEnvelope.signatures[0].sig, "string");
	}

	assert.deepEqual(checkVerifiedProvenance(verified, REALISTIC_EXPECTED), []);
});

test("a bundle carrying only the invented decoded `statement` field is rejected, not trusted", () => {
	const verified = buildVerifiedPackage({ name: "apex-code", version: "1.2.3", identity: REALISTIC_IDENTITY });
	const slsa = verified.attestationBundles.find((entry) => entry.predicateType === SLSA_PROVENANCE_PREDICATE_TYPE);
	// Exactly what the old fixtures fabricated: a plaintext statement object
	// with no signed payload behind it.
	slsa.statement = buildProvenanceStatement(REALISTIC_IDENTITY);
	delete slsa.bundle.dsseEnvelope.payload;

	assert.match(
		checkVerifiedProvenance(verified, REALISTIC_EXPECTED).join("\n"),
		/no decodable signed SLSA provenance statement payload/,
	);
});

test("negative controls: a changed payload, subject, workflow, or commit fails the signed provenance check", () => {
	const controls = [
		[
			"changed payload",
			() => {
				const verified = buildVerifiedPackage({ name: "apex-code", version: "1.2.3", identity: REALISTIC_IDENTITY });
				const slsa = verified.attestationBundles.find((entry) => entry.predicateType === SLSA_PROVENANCE_PREDICATE_TYPE);
				slsa.bundle.dsseEnvelope.payload = Buffer.from("not an in-toto statement", "utf8").toString("base64");
				return verified;
			},
			/no decodable signed SLSA provenance statement payload/,
		],
		[
			"changed subject digest",
			() => buildVerifiedPackage({
				name: "apex-code",
				version: "1.2.3",
				identity: REALISTIC_IDENTITY,
				statementOverride: buildProvenanceStatement({ ...REALISTIC_IDENTITY, subjectSha512: "b".repeat(128) }),
			}),
			/subject digest/,
		],
		[
			"changed subject name",
			() => buildVerifiedPackage({
				name: "apex-code",
				version: "1.2.3",
				identity: REALISTIC_IDENTITY,
				statementOverride: buildProvenanceStatement({ ...REALISTIC_IDENTITY, subjectName: "pkg:npm/other@1.2.3" }),
			}),
			/no subject named/,
		],
		[
			"changed workflow path",
			() => buildVerifiedPackage({
				name: "apex-code",
				version: "1.2.3",
				identity: REALISTIC_IDENTITY,
				statementOverride: buildProvenanceStatement({ ...REALISTIC_IDENTITY, workflowPath: ".github/workflows/attacker.yml" }),
			}),
			/workflow identity/,
		],
		[
			"changed repository",
			() => buildVerifiedPackage({
				name: "apex-code",
				version: "1.2.3",
				identity: REALISTIC_IDENTITY,
				statementOverride: buildProvenanceStatement({ ...REALISTIC_IDENTITY, repository: "https://github.com/attacker/apex-code" }),
			}),
			/workflow identity/,
		],
		[
			"changed tag ref",
			() => buildVerifiedPackage({
				name: "apex-code",
				version: "1.2.3",
				identity: REALISTIC_IDENTITY,
				statementOverride: buildProvenanceStatement({ ...REALISTIC_IDENTITY, workflowRef: "refs/heads/main" }),
			}),
			/workflow identity/,
		],
		[
			"changed resolved commit",
			() => buildVerifiedPackage({
				name: "apex-code",
				version: "1.2.3",
				identity: REALISTIC_IDENTITY,
				statementOverride: buildProvenanceStatement({ ...REALISTIC_IDENTITY, gitCommit: "f".repeat(40) }),
			}),
			/does not resolve expected git commit/,
		],
	];

	for (const [label, build, expectedProblem] of controls) {
		const problems = checkVerifiedProvenance(build(), REALISTIC_EXPECTED);
		assert.notEqual(problems.length, 0, `${label} must not pass`);
		assert.match(problems.join("\n"), expectedProblem, label);
	}
});
