import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	assertSnapshot,
	MANIFEST_FILE,
	replaceDirectory,
	RETRY_DELAYS_MS,
	retry,
	TARGET_DIR,
	VENDOR_DIR,
} from "./hydrate-model-data.mjs";

function snapshotDir(files = { "anthropic.json": "{}" }) {
	const dir = mkdtempSync(join(tmpdir(), "model-data-"));
	writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify({ schemaVersion: 3 }));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	return dir;
}

function harness(statuses) {
	const waited = [];
	let call = 0;
	return {
		waited,
		get calls() {
			return call;
		},
		options: { run: () => statuses[call++], wait: async (ms) => void waited.push(ms), delays: [1, 2, 3] },
	};
}

test("the vendored snapshot sits outside the frozen package", () => {
	assert.ok(!VENDOR_DIR.includes(join("packages", "ai")), `${VENDOR_DIR} would break the ADR 0001 frozen gate`);
	assert.ok(TARGET_DIR.endsWith(join("packages", "ai", "src", "providers", "data")));
});

test("a snapshot without a manifest names the command that builds one", () => {
	const dir = mkdtempSync(join(tmpdir(), "model-data-"));
	assert.throws(() => assertSnapshot(dir), /refresh:model-data/);
	rmSync(dir, { recursive: true, force: true });
});

test("a snapshot with a manifest but no providers is rejected", () => {
	const dir = snapshotDir({});
	assert.throws(() => assertSnapshot(dir), /no provider files/);
	rmSync(dir, { recursive: true, force: true });
});

test("replaceDirectory drops files a previous run left behind", () => {
	const from = snapshotDir({ "anthropic.json": '{"a":1}' });
	const to = mkdtempSync(join(tmpdir(), "model-data-out-"));
	writeFileSync(join(to, "retired-provider.json"), "{}");
	replaceDirectory(from, to);
	assert.deepEqual(readdirSync(to).sort(), [MANIFEST_FILE, "anthropic.json"]);
	rmSync(from, { recursive: true, force: true });
	rmSync(to, { recursive: true, force: true });
});

test("replaceDirectory creates a target that does not exist yet", () => {
	const from = snapshotDir();
	const parent = mkdtempSync(join(tmpdir(), "model-data-parent-"));
	const to = join(parent, "nested", "data");
	replaceDirectory(from, to);
	assert.ok(readdirSync(to).includes("anthropic.json"));
	rmSync(from, { recursive: true, force: true });
	rmSync(parent, { recursive: true, force: true });
});

test("replaceDirectory is idempotent", () => {
	const from = snapshotDir();
	const to = mkdtempSync(join(tmpdir(), "model-data-out-"));
	replaceDirectory(from, to);
	const first = readdirSync(to).sort();
	replaceDirectory(from, to);
	assert.deepEqual(readdirSync(to).sort(), first);
	rmSync(from, { recursive: true, force: true });
	rmSync(to, { recursive: true, force: true });
});

test("refresh retries a dropped connection", async () => {
	const h = harness([1, 1, 0]);
	assert.deepEqual(await retry(h.options), { status: 0, attempts: 3 });
	assert.deepEqual(h.waited, [1, 2]);
});

test("refresh surfaces the exit status of a sustained outage", async () => {
	const h = harness([1, 1, 1, 7]);
	assert.deepEqual(await retry(h.options), { status: 7, attempts: 4 });
});

test("the shipped retry schedule is three positive delays", () => {
	assert.equal(RETRY_DELAYS_MS.length, 3);
	assert.ok(RETRY_DELAYS_MS.every((ms) => Number.isInteger(ms) && ms > 0));
});
