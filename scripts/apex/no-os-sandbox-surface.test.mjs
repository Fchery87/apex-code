import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sourceDir = join(root, "packages/coding-agent/src");
const testDir = join(root, "packages/coding-agent/test");

async function typescriptFiles(directory) {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) found.push(...(await typescriptFiles(path)));
		else if (entry.name.endsWith(".ts")) found.push(path);
	}
	return found;
}

/**
 * Identifiers that existed only to enforce, describe, or configure the OS boundary.
 *
 * `sandboxEnforced` is deliberately absent: the child-run record keeps that optional field
 * for session-format stability, so a session written before the boundary was removed still
 * parses. It is never written now, and nothing can set it true.
 */
const REMOVED_SYMBOLS = [
	"core/sandbox",
	"SANDBOX_ENFORCEMENT_MARKER",
	"POLICY_SNAPSHOT_PATH",
	"requiresSandboxedChild",
	"prepareHostToolBinaries",
	"createSandboxCredentialStore",
	"sandboxContract",
	"sandboxDiagnostic",
	"sandboxProfiles",
	"allowedHosts",
	"allowDefaultHosts",
	"additionalWritableRoots",
];

const FORBIDDEN_FLAGS = ["--sandbox", "--add-dir", "--permission-profile"];

/**
 * Prose that asserts containment, in any source or test file.
 *
 * Symbols were not enough. The removal left comments describing a supervisor that no
 * longer launches anything, and two user-facing strings that still promised a boundary:
 * the bypass-permissions confirmation told the reader the OS sandbox "still confines
 * writes to the workspace and network egress to the allowlist", and the `/share` failure
 * steered users away from `gh auth login` because the sandbox used to hide those
 * credentials. A false claim in a string is worse than a stale comment, and both read as
 * ordinary prose to a symbol scan.
 */
const REMOVED_PHRASES = [
	"OS sandbox",
	"network allowlist",
	"sandbox proxy",
	"sandboxed child",
	"SandboxAuthStorage",
	"supervisor",
	"bwrap",
	"Seatbelt",
];

/**
 * Every markdown file a reader takes as a current description of the harness.
 *
 * This was five hand-listed paths, and the list was the bug. Only one of the five lived
 * under `packages/coding-agent/docs/`, which npm publishes, so four shipped pages kept
 * advertising the boundary after it was deleted. `security.md` scoped vulnerability
 * reporting against it, and `sdk.md` documented a fail-closed contract that no longer
 * refuses anything. Discovering the set is the fix; enumerating it is what failed.
 *
 * The exemptions are the records that exist to say what was removed, which have to be
 * able to name it.
 */
const HISTORICAL_RECORDS = [
	"docs/adr/",
	"docs/specs/",
	"docs/plans/",
	"docs/research/",
	"docs/roadmap.md",
	"docs/upstream-log.md",
];

/** Upstream's tree, build output, and scratch: not ours to describe and not read as current. */
const UNREAD_DIRECTORIES = new Set([".git", ".worktrees", ".apex-code", "node_modules", "dist", "vendor", "examples"]);

async function currentMarkdownFiles(directory) {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".") && entry.name !== ".github") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (UNREAD_DIRECTORIES.has(entry.name)) continue;
			found.push(...(await currentMarkdownFiles(path)));
		} else if (entry.name.endsWith(".md")) {
			// A changelog at any depth is a record of what changed, so it names removals by design.
			if (entry.name === "CHANGELOG.md") continue;
			const rel = relative(root, path).split(sep).join("/");
			if (!HISTORICAL_RECORDS.some((skip) => rel === skip || rel.startsWith(skip))) found.push(path);
		}
	}
	return found;
}

async function offendersIn(directory) {
	const offenders = [];
	for (const file of await typescriptFiles(directory)) {
		const text = await readFile(file, "utf8");
		for (const symbol of REMOVED_SYMBOLS) {
			if (text.includes(symbol)) offenders.push(`${relative(root, file)}: ${symbol}`);
		}
		const lowered = text.toLowerCase();
		for (const phrase of REMOVED_PHRASES) {
			if (lowered.includes(phrase.toLowerCase())) offenders.push(`${relative(root, file)}: "${phrase}"`);
		}
	}
	return offenders;
}

test("the OS sandbox subsystem is gone", () => {
	assert.equal(existsSync(join(sourceDir, "core/sandbox")), false);
});

test("no source file names the removed sandbox surface", async () => {
	assert.deepEqual(await offendersIn(sourceDir), []);
});

test("no test file names the removed sandbox surface", async () => {
	assert.deepEqual(await offendersIn(testDir), []);
});

test("the CLI parses and documents no containment flag", async () => {
	const args = await readFile(join(sourceDir, "cli/args.ts"), "utf8");
	for (const flag of FORBIDDEN_FLAGS) {
		assert.equal(args.includes(flag), false, `${flag} is still handled by the parser`);
	}
});

test("no current document advertises the removed containment surface", async () => {
	const offenders = [];
	for (const path of await currentMarkdownFiles(root)) {
		const doc = relative(root, path).split(sep).join("/");
		const text = await readFile(path, "utf8");
		for (const needle of [...FORBIDDEN_FLAGS, ...REMOVED_SYMBOLS, ...REMOVED_PHRASES]) {
			if (text.includes(needle)) offenders.push(`${doc}: ${needle}`);
		}
	}
	assert.deepEqual(offenders, []);
});
