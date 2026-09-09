#!/usr/bin/env node
/** Verify that npm serves the tested bytes and a signed provenance identity. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmSpawnArgs, npmSpawnOptions } from "./npm-command.mjs";
import { readReleaseArtifactManifest } from "./packed-product-surface.mjs";

export const VERIFIED_NPM_VERSION = "11.19.0";
const NPM_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

export function fetchPublishedMetadata(name, version) {
	const output = execFileSync("npm", npmSpawnArgs(["view", `${name}@${version}`, "--json"]), npmSpawnOptions({ encoding: "utf8", maxBuffer: NPM_OUTPUT_MAX_BYTES }));
	return JSON.parse(output);
}

export async function hashTarball(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	return {
		sha1: createHash("sha1").update(bytes).digest("hex"),
		sha256: createHash("sha256").update(bytes).digest("hex"),
		sha512: createHash("sha512").update(bytes).digest("hex"),
		shasum: createHash("sha1").update(bytes).digest("hex"),
		integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
	};
}

/** RI-B10. `npm publish <tarball>` sends the manifest read out of the tarball,
 * and npm only injects `gitHead` on the `publish <directory>` path
 * (@npmcli/package-json prepareSteps). Because this release publishes the
 * retained, tested tarball -- deliberately, so the published bytes are the
 * smoke-tested bytes -- the registry copy has no gitHead, and requiring one
 * would fail every real release before any provenance check ran. The commit
 * binding is asserted on the *signed* provenance statement instead (see
 * checkVerifiedProvenance's resolved gitCommit), which registry metadata could
 * never have proved on its own. A gitHead that is present must still agree.
 */
export function checkPublishedMetadata(metadata, expected) {
	const problems = [];
	if (metadata.gitHead && metadata.gitHead !== expected.gitHead) problems.push(`gitHead mismatch: registry has ${metadata.gitHead}, release tag commit is ${expected.gitHead}`);
	if (!metadata.dist?.shasum) problems.push("registry metadata has no dist.shasum");
	if (!metadata.dist?.integrity) problems.push("registry metadata has no dist.integrity");
	if (!metadata.dist?.tarball) problems.push("registry metadata has no dist.tarball URL");
	if (!metadata.dist?.attestations?.url) problems.push("no npm provenance attestation found (dist.attestations.url missing)");
	else if (metadata.dist.attestations.provenance?.predicateType !== "https://slsa.dev/provenance/v1") problems.push(`unexpected provenance predicate type: ${metadata.dist.attestations.provenance?.predicateType ?? "(none)"}`);
	return problems;
}

export function checkTarballHash(metadata, actualHashes) {
	const problems = [];
	if (metadata.dist?.shasum && metadata.dist.shasum !== (actualHashes.shasum ?? actualHashes.sha1)) problems.push(`downloaded tarball sha1 ${actualHashes.shasum ?? actualHashes.sha1} does not match registry-reported shasum ${metadata.dist.shasum}`);
	if (metadata.dist?.integrity && metadata.dist.integrity !== actualHashes.integrity) problems.push(`downloaded tarball integrity ${actualHashes.integrity} does not match registry-reported integrity ${metadata.dist.integrity}`);
	return problems;
}

export function checkDownloadedArtifact(actualHashes, expected) {
	const problems = [];
	if (actualHashes.sha256 !== expected.sha256) problems.push(`downloaded tarball sha256 ${actualHashes.sha256} does not match retained local sha256 ${expected.sha256}`);
	if (actualHashes.integrity !== expected.integrity) problems.push(`downloaded tarball integrity ${actualHashes.integrity} does not match retained local integrity ${expected.integrity}`);
	return problems;
}

export function runNpmProvenanceVerification({ npmExecutable = "npm", npmVersion, installDirectory }) {
	if (npmVersion !== VERIFIED_NPM_VERSION) throw new Error(`signed provenance verification requires npm ${VERIFIED_NPM_VERSION}, got ${npmVersion}`);
	const output = execFileSync(npmExecutable, npmSpawnArgs(["audit", "signatures", "--json", "--include-attestations", "--ignore-scripts"]), npmSpawnOptions({ cwd: installDirectory, encoding: "utf8", maxBuffer: NPM_OUTPUT_MAX_BYTES }));
	const result = JSON.parse(output);
	if (result.invalid?.length || result.missing?.length) throw new Error(`npm rejected package signatures or attestations: ${JSON.stringify({ invalid: result.invalid, missing: result.missing })}`);
	return result;
}

/** Decode the signed in-toto statement from npm's verified raw DSSE bundle.
 * npm 11.19 exposes attestationBundles[].bundle.dsseEnvelope.payload as base64;
 * the official verifier has already authenticated this envelope before this
 * function is called. Synthetic `.statement` objects are intentionally not
 * accepted because they bypass that proof.
 */
export function decodeProvenanceStatement(bundle) {
	const payload = bundle?.dsseEnvelope?.payload;
	if (typeof payload !== "string" || payload.length === 0) return undefined;
	try {
		const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
		if (!statement || typeof statement !== "object" || Array.isArray(statement)) return undefined;
		if (!Array.isArray(statement.subject) || statement.subject.length === 0) return undefined;
		if (!statement.predicate || typeof statement.predicate !== "object" || Array.isArray(statement.predicate)) return undefined;
		return statement;
	} catch { return undefined; }
}

function workflowIdentityFromStatement(statement) {
	const workflow = statement?.predicate?.buildDefinition?.externalParameters?.workflow;
	if (!workflow || typeof workflow.repository !== "string" || typeof workflow.path !== "string" || typeof workflow.ref !== "string") return undefined;
	return `${workflow.repository.replace(/\/$/, "")}/${workflow.path}@${workflow.ref}`;
}

export function checkVerifiedProvenance(verifiedPackage, expected) {
	const problems = [];
	const provenance = verifiedPackage?.attestationBundles?.find((entry) => entry.predicateType === "https://slsa.dev/provenance/v1");
	const statement = decodeProvenanceStatement(provenance?.bundle);
	if (!statement) return ["official npm verification returned no decodable signed SLSA provenance statement payload"];
	const subject = statement.subject?.find((entry) => entry.name === expected.provenanceSubject.name);
	if (!subject) problems.push(`signed provenance has no subject named ${expected.provenanceSubject.name}`);
	else if (subject.digest?.sha512 !== expected.provenanceSubject.digest.sha512) problems.push(`signed provenance subject digest ${subject.digest?.sha512 ?? "(none)"} does not match retained sha512 ${expected.provenanceSubject.digest.sha512}`);
	const actualWorkflowIdentity = workflowIdentityFromStatement(statement);
	if (actualWorkflowIdentity !== expected.workflowIdentity) problems.push(`signed provenance workflow identity ${actualWorkflowIdentity ?? "(none)"} does not match expected ${expected.workflowIdentity}`);
	const commits = statement.predicate?.buildDefinition?.resolvedDependencies
		?.map((dependency) => dependency?.digest?.gitCommit)
		?.filter((commit) => typeof commit === "string") ?? [];
	if (!commits.includes(expected.expectedGitCommit)) problems.push(`signed provenance does not resolve expected git commit ${expected.expectedGitCommit}`);
	return problems;
}

function checkMatchingVerifiedPackages(result, record) {
	const matches = (result.verified ?? []).filter((entry) => entry.name === record.packageName && entry.version === record.version);
	if (matches.length === 0) return [`npm did not return verified provenance for ${record.packageName}@${record.version}`];
	// npm reports installed locations, so root and nested copies can both match.
	// Every copy must satisfy the retained identity; never select just one.
	return matches.flatMap((entry) => checkVerifiedProvenance(entry, record));
}

export async function verifyPublishedPackage(name, version, expected) {
	const metadata = await fetchPublishedMetadata(name, version);
	const metadataProblems = checkPublishedMetadata(metadata, expected);
	if (!metadata.dist?.tarball) return { metadata, problems: metadataProblems };
	const actualHashes = await hashTarball(metadata.dist.tarball);
	return { metadata, problems: [...metadataProblems, ...checkTarballHash(metadata, actualHashes), ...(expected.sha256 ? checkDownloadedArtifact(actualHashes, expected) : [])], actualHashes };
}

function parseArgs(argv) {
	const value = (flag) => { const index = argv.indexOf(flag); return index === -1 ? undefined : argv[index + 1]; };
	const releaseManifest = value("--release-manifest");
	const manifestOut = value("--manifest-out");
	const installDirectory = value("--install-directory");
	if (!releaseManifest || !manifestOut || !installDirectory) throw new Error("Usage: node scripts/apex/verify-published-release.mjs --release-manifest <path> --install-directory <path> --manifest-out <path>");
	return { releaseManifest, manifestOut, installDirectory };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const { releaseManifest, manifestOut, installDirectory } = parseArgs(process.argv.slice(2));
		const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
		const signed = runNpmProvenanceVerification({ npmVersion, installDirectory });
		const records = readReleaseArtifactManifest(releaseManifest);
		const packages = [];
		let failed = false;
		for (const record of records) {
			const { metadata, actualHashes, problems } = await verifyPublishedPackage(record.packageName, record.version, { ...record, gitHead: record.expectedGitCommit });
			const allProblems = [...problems, ...checkMatchingVerifiedPackages(signed, record)];
			failed ||= allProblems.length > 0;
			packages.push({ ...record, registryTarball: metadata.dist?.tarball, downloadedSha256: actualHashes?.sha256, verified: allProblems.length === 0, problems: allProblems });
			console[allProblems.length ? "error" : "log"](`${allProblems.length ? "✗" : "✓"} ${record.packageName}@${record.version}: tested bytes and signed provenance ${allProblems.length ? "failed" : "verified"}`);
			// Print what actually failed. Burying the reasons in the evidence file
			// left a red release job with no diagnosis in its own log.
			for (const problem of allProblems) console.error(`  ${problem}`);
		}
		mkdirSync(dirname(manifestOut), { recursive: true });
		writeFileSync(manifestOut, `${JSON.stringify({ generatedAt: new Date().toISOString(), packages }, null, "\t")}\n`);
		process.exitCode = failed ? 1 : 0;
	} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
