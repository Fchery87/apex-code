/**
 * CHANGELOG.md transforms for the release-preparation flow (ADR 0018), extracted
 * from scripts/release.mjs so they are importable and testable without executing
 * the rest of that script's side effects (git operations, npm registry checks,
 * the full build/test suite).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPublicWorkspacePackages } from "../release-packages.mjs";

/**
 * CHANGELOG.md paths for the two Apex-owned packages only. Never a frozen
 * package's changelog (ADR 0001), which must stay byte-identical to the pinned
 * upstream tag.
 */
export function getOwnedChangelogPaths(root) {
	return getPublicWorkspacePackages(root)
		.map((pkg) => join(pkg.directory, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

export function updateChangelogsForRelease(changelogPaths, version, date = new Date().toISOString().split("T")[0]) {
	for (const changelog of changelogPaths) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const updated = content.replace("## [Unreleased]", `## [${version}] - ${date}`);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

export function addUnreleasedSection(changelogPaths) {
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogPaths) {
		const content = readFileSync(changelog, "utf-8");

		// Insert after the changelog's own title heading, whatever its exact text
		// (e.g. "# Changelog" vs. "# Apex Code changelog") -- a fixed literal here
		// previously matched only one of the two Apex-owned changelogs.
		const updated = content.replace(/^(# .+\n\n)/, `$1${unreleasedSection}`);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}
