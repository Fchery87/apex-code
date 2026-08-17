#!/usr/bin/env node
/**
 * Post-publication registry verification (ADR 0018, task 12.9).
 *
 * The pre-publication gate (scripts/apex/packed-product-surface.mjs) proves the
 * tarball CI built is identity-clean and functional. This proves the registry
 * actually distributed *that* build: the published version's `gitHead` matches
 * the release tag's commit, the tarball bytes the registry actually serves hash
 * to what the registry's own metadata claims, and npm provenance is attached --
 * catching a compromised, mismatched, or unattested publish that "the install
 * printed the right --version string" alone cannot.
 *
 * Usage:
 *   node scripts/apex/verify-published-release.mjs <name>@<version> --git-head <sha> [...]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { npmSpawnOptions } from "./npm-command.mjs";

/** `npm view <name>@<version> --json`, parsed. Throws if the version is unknown. */
export function fetchPublishedMetadata(name, version) {
	const output = execFileSync("npm", ["view", `${name}@${version}`, "--json"], npmSpawnOptions({ encoding: "utf8" }));
	return JSON.parse(output);
}

/** Download a tarball and compute the digests the registry's own `dist` block reports. */
export async function hashTarball(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download ${url}: ${response.status}`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	return {
		shasum: createHash("sha1").update(bytes).digest("hex"),
		integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
	};
}

/**
 * Compare registry metadata against the expectations a release must satisfy.
 * Pure comparison logic, no network -- `metadata` is `fetchPublishedMetadata`'s
 * (or a test fixture's) output.
 */
export function checkPublishedMetadata(metadata, expected) {
	const problems = [];

	if (!metadata.gitHead) {
		problems.push("registry metadata has no gitHead recorded for this version");
	} else if (metadata.gitHead !== expected.gitHead) {
		problems.push(`gitHead mismatch: registry has ${metadata.gitHead}, release tag commit is ${expected.gitHead}`);
	}

	if (!metadata.dist?.shasum) {
		problems.push("registry metadata has no dist.shasum");
	}
	if (!metadata.dist?.integrity) {
		problems.push("registry metadata has no dist.integrity");
	}
	if (!metadata.dist?.tarball) {
		problems.push("registry metadata has no dist.tarball URL");
	}

	if (!metadata.dist?.attestations?.url) {
		problems.push("no npm provenance attestation found (dist.attestations.url missing)");
	} else if (metadata.dist.attestations.provenance?.predicateType !== "https://slsa.dev/provenance/v1") {
		problems.push(
			`unexpected provenance predicate type: ${metadata.dist.attestations.provenance?.predicateType ?? "(none)"}`,
		);
	}

	return problems;
}

/** Compare the tarball's actual downloaded bytes against what the registry's own metadata claims. */
export function checkTarballHash(metadata, actualHashes) {
	const problems = [];
	if (metadata.dist?.shasum && metadata.dist.shasum !== actualHashes.shasum) {
		problems.push(
			`downloaded tarball sha1 ${actualHashes.shasum} does not match registry-reported shasum ${metadata.dist.shasum}`,
		);
	}
	if (metadata.dist?.integrity && metadata.dist.integrity !== actualHashes.integrity) {
		problems.push(
			`downloaded tarball integrity ${actualHashes.integrity} does not match registry-reported integrity ${metadata.dist.integrity}`,
		);
	}
	return problems;
}

/** Full verification: fetch metadata, check it, download the tarball, check its hash. */
export async function verifyPublishedPackage(name, version, expected) {
	const metadata = await fetchPublishedMetadata(name, version);
	const metadataProblems = checkPublishedMetadata(metadata, expected);
	if (!metadata.dist?.tarball) {
		return { metadata, problems: metadataProblems };
	}
	const actualHashes = await hashTarball(metadata.dist.tarball);
	const hashProblems = checkTarballHash(metadata, actualHashes);
	return { metadata, problems: [...metadataProblems, ...hashProblems] };
}

function parseArgs(argv) {
	const targets = [];
	let gitHead;
	let manifestOut;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--git-head") {
			gitHead = argv[++i];
			continue;
		}
		if (argv[i] === "--manifest-out") {
			manifestOut = argv[++i];
			continue;
		}
		targets.push(argv[i]);
	}
	if (!gitHead) throw new Error("--git-head <sha> is required");
	return { targets, gitHead, manifestOut };
}

const isMain = process.argv[1] && process.argv[1].endsWith("verify-published-release.mjs");
if (isMain) {
	try {
		const { targets, gitHead, manifestOut } = parseArgs(process.argv.slice(2));
		if (targets.length === 0) {
			throw new Error(
				"Usage: node scripts/apex/verify-published-release.mjs <name>@<version> ... --git-head <sha> [--manifest-out <path>]",
			);
		}

		let failed = false;
		const manifestEntries = [];
		for (const target of targets) {
			const atIndex = target.lastIndexOf("@");
			const name = target.slice(0, atIndex);
			const version = target.slice(atIndex + 1);
			const { metadata, problems } = await verifyPublishedPackage(name, version, { gitHead });
			manifestEntries.push({
				name,
				version,
				gitHead: metadata.gitHead,
				shasum: metadata.dist?.shasum,
				integrity: metadata.dist?.integrity,
				tarball: metadata.dist?.tarball,
				provenanceAttestationUrl: metadata.dist?.attestations?.url,
				verified: problems.length === 0,
				problems,
			});
			if (problems.length === 0) {
				console.log(`✓ ${target}: gitHead, tarball hash, and provenance all verified`);
			} else {
				failed = true;
				console.error(`✗ ${target}:`);
				for (const problem of problems) console.error(`  ${problem}`);
			}
		}

		if (manifestOut) {
			const { mkdirSync, writeFileSync } = await import("node:fs");
			const { dirname } = await import("node:path");
			mkdirSync(dirname(manifestOut), { recursive: true });
			writeFileSync(
				manifestOut,
				`${JSON.stringify({ gitHead, generatedAt: new Date().toISOString(), packages: manifestEntries }, null, "\t")}\n`,
			);
			console.log(`Wrote release evidence manifest to ${manifestOut}`);
		}

		process.exit(failed ? 1 : 0);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
