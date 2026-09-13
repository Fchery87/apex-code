import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
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

/** Documents a user reads before deciding whether to trust the harness with a repository. */
const USER_FACING_DOCS = [
	"README.md",
	"docs/user-guide.md",
	"docs/support.md",
	"packages/coding-agent/README.md",
	"packages/coding-agent/docs/settings.md",
];

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

test("no user-facing document advertises the removed containment surface", async () => {
	const offenders = [];
	for (const doc of USER_FACING_DOCS) {
		const path = join(root, doc);
		if (!existsSync(path)) continue;
		const text = await readFile(path, "utf8");
		for (const needle of [...FORBIDDEN_FLAGS, ...REMOVED_SYMBOLS, ...REMOVED_PHRASES]) {
			if (text.includes(needle)) offenders.push(`${doc}: ${needle}`);
		}
	}
	assert.deepEqual(offenders, []);
});
