import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	buildExpectedTree,
	createGit,
	parseBackports,
	UPSTREAM_BACKPORTS_FILE,
	verifyBackportProvenance,
} from "./frozen-pin.mjs";

const FROZEN = ["packages/ai"];
const repos = [];

/**
 * A miniature of the real shape: a baseline release tag, and a separate upstream
 * lineage carrying a fix that is not in any tag. The two lineages share only a root
 * commit, mirroring what upstream actually looks like -- v0.84.1 and upstream/main
 * diverge at a merge-base nine months older than either.
 */
function fixture({ fixContent = "fixed\n", baselineContent = "original\n" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "apex-frozen-pin-test-"));
	repos.push(root);
	const git = createGit(root);
	const run = (...args) => git(args, { stdio: "pipe" });

	run("init", "-q", "-b", "trunk");
	run("config", "user.email", "t@example.com");
	run("config", "user.name", "t");

	const write = (relative, contents) => {
		mkdirSync(dirname(join(root, relative)), { recursive: true });
		writeFileSync(join(root, relative), contents);
	};

	write("packages/ai/provider.ts", "original\n");
	write("README.md", "not frozen\n");
	run("add", "-A");
	run("commit", "-qm", "root");

	run("checkout", "-q", "-b", "upstream/main");
	write("packages/ai/provider.ts", fixContent);
	write("README.md", "upstream also changed this\n");
	run("add", "-A");
	run("commit", "-qm", "fix(ai): the upstream fix");
	const fixSha = run("rev-parse", "HEAD");

	run("checkout", "-q", "trunk");
	write("packages/ai/provider.ts", baselineContent);
	run("add", "-A");
	// --allow-empty: the default fixture leaves the baseline identical to the root, and
	// that case still needs a tagged commit to pin against.
	run("commit", "-q", "--allow-empty", "-m", "baseline release");
	run("tag", "v1.0.0");

	return { root, git, fixSha, write, run };
}

test.after(() => {
	for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

test("rejects an abbreviated sha, because an abbreviation can turn ambiguous later", () => {
	assert.throws(() => parseBackports("e8c632ef6 short\n"), /full 40-character/);
});

test("ignores comments and blank lines, and rejects a duplicate entry", () => {
	const sha = "a".repeat(40);
	assert.deepEqual(parseBackports(`# note\n\n${sha} subject here\n`), [
		{ sha, subject: "subject here", line: 3 },
	]);
	assert.throws(() => parseBackports(`${sha} one\n${sha} two\n`), /listed twice/);
});

test("applies the backport onto the baseline and leaves non-frozen paths alone", () => {
	const { git, fixSha, root } = fixture();
	const tree = buildExpectedTree(git, {
		baselineTag: "v1.0.0",
		backports: [{ sha: fixSha, line: 1 }],
		frozenDirectories: FROZEN,
	});

	assert.equal(createGit(root)(["show", `${tree}:packages/ai/provider.ts`]), "fixed");
	// The commit also touched README.md; a backport carries a fix across the boundary,
	// not everything else the upstream commit happened to contain.
	assert.equal(createGit(root)(["show", `${tree}:README.md`]), "not frozen");
});

test("reports a backport the baseline already contains as retired, not as a conflict", () => {
	const { git, fixSha } = fixture({ baselineContent: "fixed\n" });
	assert.throws(
		() =>
			buildExpectedTree(git, {
				baselineTag: "v1.0.0",
				backports: [{ sha: fixSha, line: 1 }],
				frozenDirectories: FROZEN,
			}),
		/already contained in v1\.0\.0.*Delete this line/s,
	);
});

test("distinguishes a genuine conflict from a retired backport", () => {
	const { git, fixSha } = fixture({ baselineContent: "diverged in a conflicting way\n" });
	assert.throws(
		() =>
			buildExpectedTree(git, {
				baselineTag: "v1.0.0",
				backports: [{ sha: fixSha, line: 1 }],
				frozenDirectories: FROZEN,
			}),
		/no longer applies/,
	);
});

test("rejects a backport that touches no frozen package", () => {
	const { git, run, write } = fixture();
	run("checkout", "-q", "upstream/main");
	write("README.md", "only non-frozen\n");
	run("add", "-A");
	run("commit", "-qm", "docs: unrelated");
	const sha = run("rev-parse", "HEAD");
	run("checkout", "-q", "trunk");

	assert.throws(
		() =>
			buildExpectedTree(git, {
				baselineTag: "v1.0.0",
				backports: [{ sha, line: 1 }],
				frozenDirectories: FROZEN,
			}),
		/touches no frozen package/,
	);
});

test("rejects a commit that upstream did not author", () => {
	const { git, run, write } = fixture();
	write("packages/ai/provider.ts", "locally invented\n");
	run("add", "-A");
	run("commit", "-qm", "local change");
	const localSha = run("rev-parse", "HEAD");

	const problems = verifyBackportProvenance(git, [{ sha: localSha, line: 1 }]);
	assert.equal(problems.length, 1);
	assert.match(problems[0], /not reachable from upstream\/main/);
});

test("accepts a commit reachable from upstream/main", () => {
	const { git, fixSha } = fixture();
	assert.deepEqual(verifyBackportProvenance(git, [{ sha: fixSha, line: 1 }]), []);
});

test("reports a sha that is not a commit at all", () => {
	const { git } = fixture();
	const problems = verifyBackportProvenance(git, [{ sha: "b".repeat(40), line: 4 }]);
	assert.equal(problems.length, 1);
	assert.match(problems[0], new RegExp(`${UPSTREAM_BACKPORTS_FILE}:4`));
	assert.match(problems[0], /not a commit/);
});
