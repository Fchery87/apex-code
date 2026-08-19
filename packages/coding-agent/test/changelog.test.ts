import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	type ChangelogEntry,
	compareVersions,
	getNewEntries,
	normalizeChangelogLinks,
	parseChangelog,
} from "../src/utils/changelog.ts";

const entry: ChangelogEntry = {
	major: 0,
	minor: 79,
	patch: 0,
	content: "",
};

// Tests must never write into the repo's own state (AGENTS.md), so fixtures go to a scratch dir.
const scratchDir = mkdtempSync(join(tmpdir(), "apex-changelog-test-"));

function writeChangelog(name: string, contents: string): string {
	const filePath = join(scratchDir, name);
	writeFileSync(filePath, contents, "utf-8");
	return filePath;
}

describe("normalizeChangelogLinks", () => {
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Project Trust](README.md#project-trust)",
			"[Extensions](docs/extensions.md#project_trust)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Project Trust](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/earendil-works/pi/blob/v0.79.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/earendil-works/pi/tree/v0.79.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/earendil-works/pi/blob/v0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("canonicalizes old repository URLs without changing external links", () => {
		const markdown = [
			"[#5167](https://github.com/earendil-works/pi-mono/pull/5167)",
			"[#4163](https://github.com/badlogic/pi-mono/issues/4163)",
			"[Agent README](https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(
			[
				"[#5167](https://github.com/earendil-works/pi/pull/5167)",
				"[#4163](https://github.com/earendil-works/pi/issues/4163)",
				"[Agent README](https://github.com/earendil-works/pi/blob/v0.79.0/packages/agent/README.md)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});

	test("pins links to the full prerelease tag", () => {
		const prereleaseEntry: ChangelogEntry = { major: 0, minor: 0, patch: 1, prerelease: "alpha.4", content: "" };

		expect(normalizeChangelogLinks("[README](README.md)", prereleaseEntry)).toBe(
			"[README](https://github.com/earendil-works/pi/blob/v0.0.1-alpha.4/packages/coding-agent/README.md)",
		);
	});
});

const APEX_CHANGELOG = `# Changelog

## [Unreleased]

## [0.0.1-alpha.4] - 2026-08-18

- Newest apex change.

## [0.0.1-alpha.3] - 2026-08-17

- Older apex change.

## Upstream Pi history

The entries below are retained as historical attribution for the forked code.

# Changelog

## [0.84.1] - 2026-08-07

- Upstream change that predates the fork.

## [0.10.0] - 2025-11-25

- Ancient upstream change.
`;

describe("parseChangelog", () => {
	test("stops at the upstream history boundary", () => {
		const entries = parseChangelog(writeChangelog("boundary.md", APEX_CHANGELOG));

		expect(entries.map((e) => `${e.major}.${e.minor}.${e.patch}-${e.prerelease}`)).toEqual([
			"0.0.1-alpha.4",
			"0.0.1-alpha.3",
		]);
	});

	test("captures the prerelease identifier so alpha builds stay distinguishable", () => {
		const entries = parseChangelog(writeChangelog("prerelease.md", APEX_CHANGELOG));

		expect(entries[0].prerelease).toBe("alpha.4");
		expect(entries[1].prerelease).toBe("alpha.3");
	});
});

describe("compareVersions", () => {
	const v = (major: number, minor: number, patch: number, prerelease?: string): ChangelogEntry => ({
		major,
		minor,
		patch,
		prerelease,
		content: "",
	});

	test("orders prereleases of the same version numerically", () => {
		expect(compareVersions(v(0, 0, 1, "alpha.4"), v(0, 0, 1, "alpha.3"))).toBeGreaterThan(0);
		expect(compareVersions(v(0, 0, 1, "alpha.3"), v(0, 0, 1, "alpha.4"))).toBeLessThan(0);
		expect(compareVersions(v(0, 0, 1, "alpha.4"), v(0, 0, 1, "alpha.4"))).toBe(0);
	});

	test("ranks a prerelease below its own stable release", () => {
		expect(compareVersions(v(0, 0, 1, "alpha.4"), v(0, 0, 1))).toBeLessThan(0);
		expect(compareVersions(v(0, 0, 1), v(0, 0, 1, "alpha.4"))).toBeGreaterThan(0);
	});
});

describe("getNewEntries", () => {
	test("does not replay the whole changelog for a prerelease version", () => {
		const entries = parseChangelog(writeChangelog("new-entries.md", APEX_CHANGELOG));

		const newEntries = getNewEntries(entries, "0.0.1-alpha.3");

		expect(newEntries.map((e) => e.prerelease)).toEqual(["alpha.4"]);
	});

	test("shows nothing when the stored version is already current", () => {
		const entries = parseChangelog(writeChangelog("current.md", APEX_CHANGELOG));

		expect(getNewEntries(entries, "0.0.1-alpha.4")).toEqual([]);
	});

	test("ignores build metadata on the stored version", () => {
		const entries = parseChangelog(writeChangelog("build-meta.md", APEX_CHANGELOG));

		expect(getNewEntries(entries, "0.0.1-alpha.4+build.7")).toEqual([]);
	});

	test("shows nothing rather than everything when the stored version is unparseable", () => {
		const entries = parseChangelog(writeChangelog("garbage.md", APEX_CHANGELOG));

		expect(getNewEntries(entries, "not-a-version")).toEqual([]);
	});
});
