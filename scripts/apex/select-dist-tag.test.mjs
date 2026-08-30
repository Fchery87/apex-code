import assert from "node:assert/strict";
import test from "node:test";
import { selectDistTag } from "./select-dist-tag.mjs";

test("a stable version always takes latest", () => {
	assert.equal(selectDistTag("1.0.0", []), "latest");
	assert.equal(selectDistTag("1.0.0", ["0.9.0", "1.0.0-rc.1"]), "latest");
	assert.equal(selectDistTag("0.1.0", ["0.0.1-alpha.10"]), "latest");
});

test("a prerelease takes latest while no stable version has ever been published", () => {
	// The state this repository is in. `latest` is what a bare install resolves,
	// and the alternative is serving a build ten versions old, which is the
	// defect ADR 0026 was written to close.
	assert.equal(selectDistTag("0.0.1-alpha.11", []), "latest");
	assert.equal(selectDistTag("0.0.1-alpha.11", ["0.0.1-alpha.9", "0.0.1-alpha.10"]), "latest");
});

test("a prerelease takes next once a stable version exists", () => {
	assert.equal(selectDistTag("1.1.0-beta.1", ["1.0.0"]), "next");
	assert.equal(selectDistTag("0.0.1-alpha.11", ["0.0.1-alpha.10", "0.0.2"]), "next");
});

test("an unparseable published version cannot make a prerelease look stable", () => {
	assert.equal(selectDistTag("0.0.1-alpha.11", ["not-a-version", ""]), "latest");
});

test("rejects a version semver cannot parse", () => {
	assert.throws(() => selectDistTag("v1.0", []), /Not a valid semver version/);
	assert.throws(() => selectDistTag("", []), /Not a valid semver version/);
});
