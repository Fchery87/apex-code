#!/usr/bin/env node

/**
 * Validates lockstep versions for the two Apex-owned packages, then synchronizes
 * internal dependency versions across all workspace packages, including private
 * ones (ADR 0018). Never targets a frozen package (ADR 0001): frozen packages are
 * a build/test dependency of the full-tree graft, not a release artifact, and
 * scripts/apex/check-frozen-packages.mjs enforces their byte-identity against the
 * pinned upstream tag -- this script must never be the thing that defeats that.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { FROZEN_PACKAGE_DIRECTORIES } from "./apex/frozen-packages.mjs";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const GENERATED_PACKAGE_SUFFIXES = [join("coding-agent", "install-lock")];

const packageRoot = process.argv[2] ?? "packages";
const repoRoot = resolve(packageRoot, "..");

const frozenDirectories = FROZEN_PACKAGE_DIRECTORIES.map((directory) => resolve(repoRoot, directory));
function isFrozen(directory) {
	return frozenDirectories.some((frozenDirectory) => directory === frozenDirectory || directory.startsWith(frozenDirectory + sep));
}

const workspacePackages = findPackageDirectories(packageRoot)
	.filter((directory) => !GENERATED_PACKAGE_SUFFIXES.some((suffix) => directory.endsWith(suffix)))
	.map((directory) => {
		const path = join(directory, "package.json");
		return { data: JSON.parse(readFileSync(path, "utf8")), path, directory: resolve(directory) };
	});
const versionMap = new Map(workspacePackages.map((pkg) => [pkg.data.name, pkg.data.version]));

// The owned release set (ADR 0018): lockstep validation and exact-dependency
// rewriting apply only to these two packages, never to frozen ones.
const ownedPackages = getPublicWorkspacePackages(repoRoot);
const ownedNames = new Set(ownedPackages.map((pkg) => pkg.name));

console.log("Apex-owned package versions:");
for (const pkg of [...ownedPackages].sort((a, b) => a.name.localeCompare(b.name))) {
	console.log(`  ${pkg.name}: ${pkg.version}`);
}

const ownedVersions = new Set(ownedPackages.map((pkg) => pkg.version));
if (ownedVersions.size > 1) {
	console.error("\nERROR: apex-code-agent-core and apex-code are not lockstep versioned.");
	console.error("Expected lockstep versioning. Run one of:");
	console.error("  npm run version:patch");
	console.error("  npm run version:minor");
	console.error("  npm run version:major");
	process.exit(1);
}

console.log("\napex-code-agent-core and apex-code are lockstep versioned.");

let totalUpdates = 0;
const updatedPackages = new Set();
for (const pkg of workspacePackages) {
	if (isFrozen(pkg.directory)) {
		continue;
	}

	for (const dependencyType of ["dependencies", "devDependencies"]) {
		const dependencies = pkg.data[dependencyType];
		if (!dependencies) {
			continue;
		}

		for (const [dependencyName, currentSpecifier] of Object.entries(dependencies)) {
			// Registry aliases such as `npm:@earendil-works/pi-ai@0.1.2` are never workspace-linked,
			// so lockstep bumping them would point at a version that is not published yet.
			const version = versionMap.get(dependencyName);
			if (!version) {
				continue;
			}

			// An Apex-owned package is depended on exactly, never by range (ADR 0018):
			// apex-code's dependency on apex-code-agent-core must match what
			// scripts/apex/validate-release-tag.mjs enforces at the release gate.
			const newSpecifier = ownedNames.has(dependencyName) ? version : `^${version}`;
			if (currentSpecifier === newSpecifier) {
				continue;
			}

			console.log(`\n${pkg.data.name}:`);
			console.log(
				`  ${dependencyName}: ${currentSpecifier} → ${newSpecifier}${dependencyType === "devDependencies" ? " (devDependencies)" : ""}`,
			);
			dependencies[dependencyName] = newSpecifier;
			updatedPackages.add(pkg);
			totalUpdates++;
		}
	}
}

for (const pkg of updatedPackages) {
	writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
}

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies are already in sync.");
} else {
	console.log(`\nUpdated ${totalUpdates} dependency version(s).`);
}
