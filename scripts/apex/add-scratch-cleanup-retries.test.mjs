import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addRetryOptions, needsRetryOptions, spawnsProcesses } from "./add-scratch-cleanup-retries.mjs";

test("adds retry options to a recursive rmSync that lacks them", () => {
	const before = 'afterEach(() => { rmSync(dir, { recursive: true, force: true }); });';
	assert.equal(
		addRetryOptions(before),
		'afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });',
	);
});

test("adds retry options when force is absent", () => {
	assert.equal(
		addRetryOptions("rmSync(tempDir, { recursive: true })"),
		"rmSync(tempDir, { recursive: true, maxRetries: 10, retryDelay: 50 })",
	);
});

test("strips a trailing comma instead of emitting `,,`", () => {
	// The first version produced `{ recursive: true, force: true,, maxRetries: 10 ... }`,
	// which is invalid TypeScript. None of the 36 rewritten files happened to carry a
	// trailing comma, so the gate passed by luck rather than by being right.
	assert.equal(
		addRetryOptions("rmSync(dir, { recursive: true, force: true, })"),
		"rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })",
	);
});

test("leaves a site that already enables retries alone, whatever delay it tunes", () => {
	// `maxRetries` is the switch. A deliberate `maxRetries: 3` is already race-safe, and
	// rewriting it would churn someone's tuning and make the gate demand a specific delay.
	const tuned = "rmSync(dir, { recursive: true, maxRetries: 3 })";
	assert.equal(addRetryOptions(tuned), tuned);
	assert.equal(needsRetryOptions(`spawn("node", []);\n${tuned}`), false);
});

test("does not emit a duplicate retryDelay when one is already present", () => {
	// `retryDelay` alone is inert because Node ignores it without `maxRetries`, but a site
	// may still carry one, and appending a second would leave a duplicate key.
	assert.equal(
		addRetryOptions("rmSync(dir, { recursive: true, retryDelay: 20 })"),
		"rmSync(dir, { recursive: true, retryDelay: 20, maxRetries: 10 })",
	);
});

test("is idempotent, so the codemod can be re-run", () => {
	const once = addRetryOptions("rmSync(dir, { recursive: true, force: true })");
	assert.equal(addRetryOptions(once), once);
});

test("leaves a non-recursive rmSync alone, because Node ignores retries without recursive", () => {
	const source = "rmSync(file, { force: true })";
	assert.equal(addRetryOptions(source), source);
});

test("only flags files that can actually lose the race", () => {
	const cleanup = "rmSync(dir, { recursive: true, force: true })";
	assert.equal(needsRetryOptions(cleanup), false, "no spawn means no handle to race");
	assert.equal(needsRetryOptions(`spawn("node", []);\n${cleanup}`), true);
	assert.equal(needsRetryOptions(`execFileSync("node", []);\n${cleanup}`), true);
});

test("recognizes each spawn shape the repository uses", () => {
	for (const call of ["spawn(", "spawnSync(", "execFile(", "execFileSync(", "runPolicyCommand(", "fork("]) {
		assert.equal(spawnsProcesses(`await ${call})`), true, call);
	}
	assert.equal(spawnsProcesses("forkSession()"), false, "must not match an unrelated identifier");
});

test("the retry options survive a real removal, so the rewrite is not merely cosmetic", () => {
	const root = mkdtempSync(join(tmpdir(), "scratch-retry-"));
	try {
		const nested = join(root, "a", "b");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "f.txt"), "x");
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		assert.equal(existsSyncSafe(root), false);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

function existsSyncSafe(path) {
	try {
		execFileSync(process.execPath, ["-e", `require("node:fs").statSync(${JSON.stringify(path)})`], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}
