/**
 * Chooses the one npm dist-tag a release publishes under (ADR 0026).
 *
 * One tag, because npm Trusted Publishing authenticates `npm publish` and
 * `npm stage publish` and nothing else; `npm dist-tag add` needs traditional
 * authentication. A workflow that set a second tag would therefore need a
 * stored npm token, and `docs/release-governance-checklist.md` treats any such
 * standing token as a live bypass of the OIDC path rather than a convenience.
 *
 * The rule that follows from one tag: `latest` is what a bare `npm install
 * apex-code` resolves, so it must name the newest build this project stands
 * behind. While no stable version has ever been published, the newest verified
 * prerelease is the only honest answer, and `next` means nothing because there
 * is no stable line for it to run ahead of. Once a stable version exists the
 * usual split applies and a prerelease stops taking `latest`.
 *
 * `selectDistTag` is a pure function of the version and the registry's
 * published list, so the moment a stable version lands the behaviour flips with
 * no code change here.
 *
 * Node builtins only. `.github/workflows/release.yml` runs this in its tag
 * validation step, which is before `npm ci`, exactly as `validate-release-tag.mjs`
 * is.
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { npmSpawnArgs, npmSpawnOptions } from "./npm-command.mjs";

/** SemVer 2.0.0, from semver.org. Group 4 is the prerelease component. */
const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parse(version) {
	return typeof version === "string" ? SEMVER.exec(version) : null;
}

export function selectDistTag(version, publishedVersions) {
	const parsed = parse(version);
	if (!parsed) throw new Error(`Not a valid semver version: ${version}`);
	if (parsed[4] === undefined) return "latest";

	const anyStablePublished = publishedVersions.some((published) => {
		const other = parse(published);
		return other !== null && other[4] === undefined;
	});
	return anyStablePublished ? "next" : "latest";
}

export function publishedVersionsOf(packageName) {
	try {
		const args = npmSpawnArgs(["view", packageName, "versions", "--json"]);
		const output = execFileSync("npm", args, { encoding: "utf8", ...npmSpawnOptions() });
		const parsed = JSON.parse(output);
		// A package with exactly one published version returns a bare string.
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		// An unpublished package has no versions, which is not an error here.
		return [];
	}
}

// A relative argv[1] does not string-compare against import.meta.url, so the CLI
// block silently never runs. pathToFileURL resolves it the same way node does.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [version, ...packages] = process.argv.slice(2);
	if (!version || packages.length === 0) {
		console.error("Usage: node scripts/apex/select-dist-tag.mjs <version> <package>...");
		process.exit(1);
	}
	// Every Apex-owned package takes the same tag in one release, so a stable
	// version anywhere in the set settles it for all of them.
	const published = packages.flatMap((name) => publishedVersionsOf(name));
	process.stdout.write(selectDistTag(version, published));
}
