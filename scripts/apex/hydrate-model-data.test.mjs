import assert from "node:assert/strict";
import { test } from "node:test";
import { hydrateWithRetry, RETRY_DELAYS_MS } from "./hydrate-model-data.mjs";

function harness(statuses) {
	const waited = [];
	const retries = [];
	let call = 0;
	return {
		waited,
		retries,
		get calls() {
			return call;
		},
		options: {
			run: () => statuses[call++],
			wait: async (ms) => void waited.push(ms),
			onRetry: (event) => retries.push(event),
			delays: [1, 2, 3],
		},
	};
}

test("a first-attempt success never waits", async () => {
	const h = harness([0]);
	assert.deepEqual(await hydrateWithRetry(h.options), { status: 0, attempts: 1 });
	assert.equal(h.calls, 1);
	assert.deepEqual(h.waited, []);
});

test("a dropped connection retries and reports success", async () => {
	const h = harness([1, 1, 0]);
	assert.deepEqual(await hydrateWithRetry(h.options), { status: 0, attempts: 3 });
	assert.deepEqual(h.waited, [1, 2]);
	assert.deepEqual(
		h.retries.map((r) => r.attempt),
		[1, 2],
	);
});

test("a sustained outage exhausts the schedule and surfaces the exit status", async () => {
	const h = harness([1, 1, 1, 7]);
	assert.deepEqual(await hydrateWithRetry(h.options), { status: 7, attempts: 4 });
	assert.deepEqual(h.waited, [1, 2, 3]);
});

test("the shipped schedule retries three times", () => {
	assert.equal(RETRY_DELAYS_MS.length, 3);
	assert.ok(RETRY_DELAYS_MS.every((ms) => Number.isInteger(ms) && ms > 0));
});
