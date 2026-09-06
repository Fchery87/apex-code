#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseArtifactManifest } from "./packed-product-surface.mjs";
import { npmSpawnArgs, npmSpawnOptions } from "./npm-command.mjs";

export function selectReleaseArtifact(records, packageName) {
	const matches = records.filter((record) => record.packageName === packageName);
	if (matches.length !== 1) throw new Error(`expected one release artifact for ${packageName}, found ${matches.length}`);
	return matches[0];
}

export function assertRetainedArtifact(record) {
	const bytes = readFileSync(record.tarballPath);
	const actualSha256 = createHash("sha256").update(bytes).digest("hex");
	const actualIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	if (actualSha256 !== record.sha256 || actualIntegrity !== record.integrity) {
		throw new Error(`retained release artifact changed after testing: ${record.tarballPath}`);
	}
}

export function publishReleaseArtifact({ manifestPath, packageName, tag, npmExecutable = "npm", dryRun = false }) {
	const record = selectReleaseArtifact(readReleaseArtifactManifest(resolve(manifestPath)), packageName);
	assertRetainedArtifact(record);
	const args = ["publish", record.tarballPath, "--access", "public", "--provenance", "--tag", tag, "--ignore-scripts"];
	if (dryRun) args.push("--dry-run");
	execFileSync(npmExecutable, npmSpawnArgs(args), npmSpawnOptions({ stdio: "inherit" }));
	return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [manifestPath, packageName, tag, ...extra] = process.argv.slice(2);
	if (!manifestPath || !packageName || !tag || extra.length > 0) {
		console.error("Usage: node scripts/apex/publish-release-artifact.mjs <manifest> <package-name> <dist-tag>");
		process.exitCode = 1;
	} else {
		try { publishReleaseArtifact({ manifestPath, packageName, tag }); }
		catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
	}
}
