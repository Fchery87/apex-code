import assert from "node:assert/strict";
import test from "node:test";
import { npmSpawnArgs, npmSpawnOptions } from "./npm-command.mjs";

test("npmSpawnArgs leaves arguments untouched on non-Windows platforms", () => {
	const args = ["sbom", "--workspace", "/some/path with a space/packages/agent"];
	assert.deepEqual(npmSpawnArgs(args, "linux"), args);
	assert.deepEqual(npmSpawnArgs(args, "darwin"), args);
});

test("npmSpawnArgs quotes a Windows path containing the repo's own required spaced checkout", () => {
	// The exact shape that broke on real Windows CI: shell:true does not itself
	// quote array arguments, so an unquoted space-containing --workspace value
	// was silently truncated by cmd.exe's own tokenizing.
	const path = String.raw`D:\a\apex-code\apex-code\apex code checkout\packages\agent`;
	const quoted = npmSpawnArgs(["sbom", "--workspace", path], "win32");
	assert.deepEqual(quoted, ["sbom", "--workspace", `"${path}"`]);
});

test("npmSpawnArgs leaves plain flags and identifiers unquoted on Windows", () => {
	const args = npmSpawnArgs(["view", "apex-code@1.2.3", "--json"], "win32");
	assert.deepEqual(args, ["view", "apex-code@1.2.3", "--json"]);
});

test("npmSpawnArgs doubles a trailing backslash before the closing quote", () => {
	// Without doubling, a path ending in a single backslash immediately before
	// the closing quote escapes that quote instead of closing the argument --
	// the standard MS CRT command-line parsing rule.
	const backslash = "\\";
	const path = `C:${backslash}some dir${backslash}`;
	const [quoted] = npmSpawnArgs([path], "win32");
	const expected = `"C:${backslash}some dir${backslash}${backslash}"`;
	assert.equal(quoted, expected);
});

test("npmSpawnOptions sets shell only on Windows", () => {
	assert.equal(npmSpawnOptions({}, "win32").shell, true);
	assert.equal(npmSpawnOptions({}, "linux").shell, false);
	assert.equal(npmSpawnOptions({}, "darwin").shell, false);
});

test("npmSpawnOptions preserves other options", () => {
	const options = npmSpawnOptions({ cwd: "/workspace", encoding: "utf8" }, "win32");
	assert.equal(options.cwd, "/workspace");
	assert.equal(options.encoding, "utf8");
});
