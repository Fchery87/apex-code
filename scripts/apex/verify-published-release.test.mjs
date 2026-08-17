import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	checkPublishedMetadata,
	checkTarballHash,
	fetchPublishedMetadata,
	hashTarball,
	verifyPublishedPackage,
} from "./verify-published-release.mjs";

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

test("checkPublishedMetadata catches a missing gitHead entirely", () => {
	const problems = checkPublishedMetadata(fixtureMetadata({ gitHead: undefined }), { gitHead: "abc123" });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /no gitHead recorded/);
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

// Real network calls against an already-published, real package
// (@earendil-works/pi-ai, a frozen upstream dependency this repo already
// consumes -- never one of Apex's own packages) to prove the registry-metadata
// shape assumptions and the hash-comparison logic hold against the real npm
// registry, not just a fixture shaped by hand.
test("fetchPublishedMetadata and hashTarball work against a real, already-published package", async () => {
	const metadata = await fetchPublishedMetadata("@earendil-works/pi-ai", "0.84.1");
	assert.equal(metadata.gitHead, "53fa77ccd8a279eb87e92294ef3687b03ff80112");
	assert.ok(metadata.dist?.attestations?.url, "expected this real package to carry npm provenance");

	const hashes = await hashTarball(metadata.dist.tarball);
	assert.equal(hashes.shasum, metadata.dist.shasum);
	assert.equal(hashes.integrity, metadata.dist.integrity);
});

test("verifyPublishedPackage passes end to end for a real, already-published package with the right gitHead", async () => {
	const { problems } = await verifyPublishedPackage("@earendil-works/pi-ai", "0.84.1", {
		gitHead: "53fa77ccd8a279eb87e92294ef3687b03ff80112",
	});
	assert.deepEqual(problems, []);
});

test("verifyPublishedPackage reports a gitHead mismatch for a real package with the wrong expected commit", async () => {
	const { problems } = await verifyPublishedPackage("@earendil-works/pi-ai", "0.84.1", {
		gitHead: "0000000000000000000000000000000000000000",
	});
	assert.equal(problems.length, 1);
	assert.match(problems[0], /gitHead mismatch/);
});

test("CLI --manifest-out writes durable release evidence for a real, already-published package", async () => {
	const scriptPath = fileURLToPath(new URL("./verify-published-release.mjs", import.meta.url));
	const outDir = await mkdtemp(join(tmpdir(), "apex-verify-manifest-"));
	try {
		const manifestPath = join(outDir, "release-evidence.json");
		const result = spawnSync(
			process.execPath,
			[
				scriptPath,
				"@earendil-works/pi-ai@0.84.1",
				"--git-head",
				"53fa77ccd8a279eb87e92294ef3687b03ff80112",
				"--manifest-out",
				manifestPath,
			],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);

		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		assert.equal(manifest.gitHead, "53fa77ccd8a279eb87e92294ef3687b03ff80112");
		assert.equal(manifest.packages.length, 1);
		assert.equal(manifest.packages[0].verified, true);
		assert.equal(manifest.packages[0].shasum, "e3e6318392a9f6df6fcc9040dcfafa5e5fb779f4");
		assert.ok(manifest.packages[0].provenanceAttestationUrl);
	} finally {
		await rm(outDir, { recursive: true, force: true });
	}
});
