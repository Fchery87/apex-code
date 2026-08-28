import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "upstream-merge.sh"), "utf8");
/** Comments explain the failures by naming the commands that caused them, so assertions
 * about what the script *runs* have to read past them. */
const code = script
	.split("\n")
	.filter((line) => !line.trimStart().startsWith("#"))
	.join("\n");

/**
 * These guard the two failures that made the documented merge path unusable from the
 * graft until 2026-08-27, both of which looked like success from the outside.
 */

test("never fetches --tags, which exits non-zero on the graft-era tags and kills the run", () => {
	assert.doesNotMatch(code, /git fetch[^\n]*--tags/);
	assert.match(code, /git fetch --quiet upstream "refs\/tags\/\$\{target\}:refs\/tags\/\$\{target\}"/);
});

test("merges against the recorded pin as an explicit base, not against commit lineage", () => {
	assert.match(code, /git merge-tree --write-tree --merge-base="\$\{pin\}"/);
	// `git merge <tag>` here spans a 2025-11-26 merge-base and rewrites the whole tree.
	assert.doesNotMatch(code, /git merge --no-commit/);
});

test("aborts instead of advancing the pin when merge-tree cannot run", () => {
	assert.match(code, /merge_status.*-gt 1/s);
	const abort = code.indexOf("Nothing has been changed");
	const advance = code.indexOf("> .upstream-tag");
	assert.notEqual(abort, -1, "expected an abort path when merge-tree fails outright");
	assert.ok(abort < advance, "the abort must come before the pin is advanced");
});

test("counts conflicts from the merged content, not from unmerged index entries", () => {
	// git apply -3 leaves conflicted content with no unmerged index entry, so an
	// index-based count reported zero for a merge that had applied nothing at all.
	assert.match(code, /git grep -c '\^<<<<<<< '/);
	assert.doesNotMatch(code, /--diff-filter=U/);
});

test("reads the merged tree without a pipe that can close early", () => {
	// See the comment in the script: `| head -1` takes SIGPIPE once merge-tree's conflict
	// list outgrows the pipe buffer, and pipefail turns that into a silent abort.
	assert.doesNotMatch(code, /merge_output[^\n]*\|\s*head/);
	assert.match(code, /tree="\$\{merge_output%%/);
});

test("names a file Apex deleted that upstream resurrects, not just the marker-bearing conflicts", () => {
	// A modify/delete conflict (upstream touches a path the ADR 0001 boundary commit
	// deliberately removed, e.g. a .github/ workflow) is resolved by merge-tree with
	// upstream's content and zero `<<<<<<<` markers, so `hunks` never sees it and a
	// review that only greps for markers walks straight past a resurrected file. The
	// v0.84.3 merge did exactly this to .github/APPROVED_CONTRIBUTORS and
	// .github/workflows/build-binaries.yml, both silently re-added.
	assert.match(code, /CONFLICT \\\(modify\\\/delete\\\)/); // matches the awk pattern's literal escaping
	assert.match(code, /resurrected/);
	// Must be parsed from `messages`, the same text already captured, not a second
	// re-run of merge-tree.
	assert.match(code, /resurrected="\$\(printf '%s\\n' "\$\{messages\}"/);
});
