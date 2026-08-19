import path from "node:path";
import { existsSync, readFileSync } from "fs";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	/** Prerelease identifier without the leading dash, e.g. "alpha.4". Absent on stable releases. */
	prerelease?: string;
	content: string;
}

const GITHUB_REPO = "earendil-works/pi";
/**
 * Everything below this heading is pre-fork Pi history, kept in CHANGELOG.md for attribution.
 * Those versions (0.10.x - 0.84.x) sort above Apex Code's own 0.0.x line, so leaving them in
 * scope would make every launch replay the entire upstream history as "What's New".
 */
const UPSTREAM_HISTORY_HEADING_RE = /^##\s+Upstream Pi history\s*$/i;
const VERSION_HEADING_RE = /##\s+\[?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.-]+)?\]?/;
const VERSION_STRING_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.-]+)?$/;
const CHANGELOG_LINK_BASE_PATH = "packages/coding-agent";
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

function entryVersion(entry: ChangelogEntry): string {
	const core = `${entry.major}.${entry.minor}.${entry.patch}`;
	return entry.prerelease ? `${core}-${entry.prerelease}` : core;
}

/**
 * Parse a version string into a comparable entry. Build metadata is ignored per semver.
 * Returns undefined when the string is not a version, so callers can decline to guess.
 */
function parseVersionString(version: string): ChangelogEntry | undefined {
	const match = version.trim().match(VERSION_STRING_RE);
	if (!match) {
		return undefined;
	}

	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		prerelease: match[4],
		content: "",
	};
}

/**
 * Compare semver prerelease identifiers. A missing prerelease outranks any prerelease,
 * numeric identifiers compare numerically, and a longer identifier set wins a shared prefix.
 */
function comparePrerelease(a: string | undefined, b: string | undefined): number {
	if (a === b) return 0;
	if (a === undefined) return 1;
	if (b === undefined) return -1;

	const aParts = a.split(".");
	const bParts = b.split(".");

	for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
		const aPart = aParts[i];
		const bPart = bParts[i];
		if (aPart === undefined) return -1;
		if (bPart === undefined) return 1;
		if (aPart === bPart) continue;

		const aNumeric = /^\d+$/.test(aPart);
		const bNumeric = /^\d+$/.test(bPart);
		if (aNumeric && bNumeric) {
			return Number.parseInt(aPart, 10) - Number.parseInt(bPart, 10);
		}
		if (aNumeric !== bNumeric) {
			// Numeric identifiers always have lower precedence than alphanumeric ones.
			return aNumeric ? -1 : 1;
		}
		return aPart < bPart ? -1 : 1;
	}

	return 0;
}

function normalizeTag(version: string | ChangelogEntry): string {
	const versionString = typeof version === "string" ? version : entryVersion(version);
	return versionString.startsWith("v") ? versionString : `v${versionString}`;
}

function splitLocalTarget(target: string): { fragment: string; pathPart: string; query: string } {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function normalizePathPart(value: string): string {
	return value.replaceAll("\\", "/");
}

function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(CHANGELOG_LINK_BASE_PATH, normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function isDirectoryTarget(originalPath: string, repositoryPath: string): boolean {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function normalizeChangelogLinkTarget(target: string, tag: string): string {
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${GITHUB_REPO}`);
	const repoUrl = `https://github.com/${GITHUB_REPO}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${GITHUB_REPO}/${route}/${tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

export function normalizeChangelogLinks(markdown: string, version: string | ChangelogEntry): string {
	const tag = normalizeTag(version);
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag)}${suffix}`;
	});
}

/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF.
 * Stops at the upstream history heading — those entries are attribution, not Apex Code releases.
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: Omit<ChangelogEntry, "content"> | null = null;

		for (const line of lines) {
			// Check if this is a version header (## [x.y.z] ...)
			if (line.startsWith("## ")) {
				// Save previous entry if exists
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
					currentVersion = null;
					currentLines = [];
				}

				// Everything past the attribution boundary belongs to the pre-fork project.
				if (UPSTREAM_HISTORY_HEADING_RE.test(line.trim())) {
					break;
				}

				// Try to parse version from this line
				const versionMatch = line.match(VERSION_HEADING_RE);
				if (versionMatch) {
					currentVersion = {
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
						prerelease: versionMatch[4],
					};
					currentLines = [line];
				} else {
					// Reset if we can't parse version
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// Collect lines for current version
				currentLines.push(line);
			}
		}

		// Save last entry
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	if (v1.patch !== v2.patch) return v1.patch - v2.patch;
	return comparePrerelease(v1.prerelease, v2.prerelease);
}

/**
 * Get entries newer than lastVersion.
 * An unparseable lastVersion yields nothing: replaying the entire changelog on every launch
 * is a far worse failure than staying quiet about one upgrade.
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	const last = parseVersionString(lastVersion);
	if (!last) {
		return [];
	}

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config.ts";
