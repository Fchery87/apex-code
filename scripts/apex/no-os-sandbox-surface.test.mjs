import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { UPSTREAM_OWNED_DOCS } from "./upstream-owned-docs.mjs";
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
 * Files allowed to name a removed identifier, and exactly which ones.
 *
 * A deprecation notice has to name what it deprecates. `core/removed-settings.ts` tells an
 * upgrader that three settings keys stopped restricting anything (ADR 0032), and it cannot
 * say so without writing them down. Without this the guard forbids the one message that
 * makes the removal survivable, which is the opposite of what it exists for.
 *
 * Keyed by file *and* symbol so it cannot widen into a general amnesty. Any other removed
 * identifier in the same file still fails, and these three still fail everywhere else.
 */
const NAMING_EXEMPTIONS = new Map([
	[
		"packages/coding-agent/src/core/removed-settings.ts",
		["allowedHosts", "allowDefaultHosts", "sandboxProfiles"],
	],
	[
		"packages/coding-agent/test/settings-diagnostics.test.ts",
		["allowedHosts", "allowDefaultHosts", "sandboxProfiles"],
	],
	// The one file whose subject is the removal itself. It disposes of the 2026-09-05
	// findings table, and nine of those rows named a supervisor, a Seatbelt profile, or
	// another piece of the deleted boundary. Naming what a row described is how a reader
	// can tell a retirement from an oversight, and the file's own case asserts
	// `core/sandbox` is absent, so it fails the moment the boundary comes back. That is
	// the opposite of the claim this guard exists to catch.
	[
		"packages/coding-agent/test/security-boundary/findings-2026-09-05.test.ts",
		["supervisor", "Seatbelt"],
	],
]);

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
	"docs/research/",
	"docs/roadmap.md",
	"docs/upstream-log.md",
	// A plan's task table records what was built, task by task, and says so in the past
	// tense by design. The check that matters for a plan is that the source files it names
	// still exist, which `scripts/validate-docs-lifecycle.mjs` already enforces.
	"docs/plans/",
	...UPSTREAM_OWNED_DOCS,
];

/**
 * Directories whose documents are exempt only once they are finished.
 *
 * A `Superseded` or `Landed` spec has to be able to name what it built, and exempting the
 * directory was the cheap way to allow that. It also exempted every *live* document in it.
 * `2026-09-11-trust-classification-and-proof-integrity.md` is `Active`, governs open work,
 * and still says "on Linux and macOS the OS sandbox still confines the resulting execution
 * to the workspace and the allowlisted hosts" -- the sentence that sets the severity of a
 * finding someone is meant to act on. The guard passed five of five while it said that.
 *
 * Status is the right key, not the directory. A document that describes the past may name
 * the past; one that describes the present may not.
 */
const FINISHED_ONLY_RECORDS = ["docs/specs/"];
const FINISHED_STATUS = /^\*\*Status:\*\*\s*(Superseded|Landed)\b/m;

/**
 * An `Active` spec may still name the removed surface, but only after saying out loud that
 * it has been read against the removal. Status alone is too blunt: a spec can be `Active`
 * because its phase is unfinished while its prose has already been reconciled. Requiring
 * the sentence is what makes that a claim someone made rather than a directory they
 * happened to sit in.
 */
const RECONCILED = /^> \*\*Reconciled with \[ADR 0032\]/m;

/**
 * Workflow files. They are neither source nor prose and were scanned as neither, which is
 * how `release.yml` kept installing Bubblewrap and describing "bubblewrap for OS sandbox
 * enforcement" for a boundary deleted a day earlier. The 2026-09-12 deletion inventory
 * recorded that step as "removed from `.github/workflows/ci.yml`" and named one of the two
 * workflows that had it.
 */
const WORKFLOW_DIR = ".github/workflows";

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
			if (HISTORICAL_RECORDS.some((skip) => rel === skip || rel.startsWith(skip))) continue;
			if (FINISHED_ONLY_RECORDS.some((prefix) => rel.startsWith(prefix))) {
				const text = await readFile(path, "utf8");
				if (FINISHED_STATUS.test(text) || RECONCILED.test(text)) continue;
			}
			found.push(path);
		}
	}
	return found;
}

async function offendersIn(directory) {
	const offenders = [];
	for (const file of await typescriptFiles(directory)) {
		const text = await readFile(file, "utf8");
		const rel = relative(root, file).split(sep).join("/");
		const permitted = NAMING_EXEMPTIONS.get(rel) ?? [];
		for (const symbol of REMOVED_SYMBOLS) {
			if (permitted.includes(symbol)) continue;
			if (text.includes(symbol)) offenders.push(`${relative(root, file)}: ${symbol}`);
		}
		const lowered = text.toLowerCase();
		for (const phrase of REMOVED_PHRASES) {
			if (permitted.includes(phrase)) continue;
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

async function workflowFiles() {
	const directory = join(root, WORKFLOW_DIR);
	if (!existsSync(directory)) return [];
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isFile() && /\.ya?ml$/.test(entry.name)) found.push(join(directory, entry.name));
	}
	return found;
}

test("no workflow installs or describes the removed containment surface", async () => {
	const offenders = [];
	for (const path of await workflowFiles()) {
		const doc = relative(root, path).split(sep).join("/");
		const text = await readFile(path, "utf8");
		for (const needle of [...FORBIDDEN_FLAGS, ...REMOVED_SYMBOLS, ...REMOVED_PHRASES, "bubblewrap"]) {
			if (text.toLowerCase().includes(needle.toLowerCase())) offenders.push(`${doc}: ${needle}`);
		}
	}
	assert.deepEqual(offenders, []);
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
