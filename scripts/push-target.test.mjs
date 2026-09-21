import assert from "node:assert/strict";
import test from "node:test";

import { describeProtectedPush } from "./push-target.mjs";

const FEATURE = "refs/heads/fix/something abc123 refs/heads/fix/something def456\n";
const MAIN = "refs/heads/main abc123 refs/heads/main def456\n";
const TAG = "refs/tags/v0.1.0 abc123 refs/tags/v0.1.0 0000000000000000000000000000000000000000\n";

test("a feature branch pushes freely", () => {
	assert.equal(describeProtectedPush(FEATURE, {}), undefined);
});

test("a tag pushes freely, because releases push tags", () => {
	assert.equal(describeProtectedPush(TAG, {}), undefined);
});

test("a direct push to main is refused", () => {
	const message = describeProtectedPush(MAIN, {});
	assert.ok(message);
	assert.match(message, /main/);
	assert.match(message, /PI_ALLOW_MAIN_PUSH/);
});

test("main is caught even when it rides along with other refs", () => {
	assert.ok(describeProtectedPush(FEATURE + MAIN, {}));
	assert.ok(describeProtectedPush(MAIN + TAG, {}));
});

test("deleting main is refused too", () => {
	const deletion = "(delete) 0000000000000000000000000000000000000000 refs/heads/main def456\n";
	assert.ok(describeProtectedPush(deletion, {}));
});

test("the release script's explicit opt-in is honored", () => {
	assert.equal(describeProtectedPush(MAIN, { PI_ALLOW_MAIN_PUSH: "1" }), undefined);
	assert.equal(describeProtectedPush(MAIN, { PI_ALLOW_MAIN_PUSH: "true" }), undefined);
	assert.ok(describeProtectedPush(MAIN, { PI_ALLOW_MAIN_PUSH: "0" }), "an unset-ish value must not open the gate");
});

test("an empty or malformed stdin does not block a push", () => {
	assert.equal(describeProtectedPush("", {}), undefined);
	assert.equal(describeProtectedPush("garbage\n", {}), undefined);
});
