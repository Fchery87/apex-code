#!/usr/bin/env node
/**
 * Assert that every consumed ("frozen") Pi package is byte-identical to the
 * pinned upstream tag.
 *
 * ADR 0001 forks `packages/coding-agent` and `packages/agent` and consumes
 * everything else. Because Apex Code is a full-tree graft, the consumed packages
 * are physically present in this repository and are therefore editable by
 * accident — which is the one real risk of that graft shape.
 *
 * This check turns "do not patch consumed packages" from an honor-system rule
 * into a build failure. Without it, ADR 0001's boundary is a comment.
 *
 * Usage:
 *   node scripts/apex/check-frozen-packages.mjs
 *   node scripts/apex/check-frozen-packages.mjs --tag v0.84.1
 *
 * Exit 0 when every frozen package matches; exit 1 with a diffstat when not.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { FROZEN_PACKAGE_DIRECTORIES } from "./frozen-packages.mjs";
import {
  buildExpectedTree,
  createGit,
  readBackports,
  UPSTREAM_BACKPORTS_FILE,
  UPSTREAM_BRANCH,
  UPSTREAM_REMOTE,
  verifyBackportProvenance,
} from "./frozen-pin.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Consumed packages. Everything under packages/ that Apex Code does NOT fork.
 *
 * `evals` and `session-backends` were deleted from the tree rather than frozen.
 * Both depended on the two forked packages, so the Task 0.3 rename would have
 * left them pointing at names that no longer exist in the workspace — and npm
 * would have quietly resolved those from the registry instead, building them
 * against UPSTREAM's published packages while CI stayed green. Neither is used
 * by Apex Code. See docs/upstream-log.md.
 */
const FROZEN = FROZEN_PACKAGE_DIRECTORIES;

const git = createGit(REPO_ROOT);

function readPinnedTag() {
  const flagIndex = process.argv.indexOf("--tag");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return process.argv[flagIndex + 1];
  }
  try {
    return readFileSync(resolve(REPO_ROOT, ".upstream-tag"), "utf8").trim();
  } catch {
    fail(
      "no .upstream-tag file and no --tag argument.\n" +
        "  .upstream-tag pins the upstream release the frozen packages must match.\n" +
        "  It is updated by scripts/apex/upstream-merge.sh on every merge.",
    );
  }
}

function fail(message) {
  console.error(`\n✗ frozen-package check: ${message}\n`);
  process.exit(1);
}

function ensureTagPresent(tag) {
  try {
    git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { stdio: "pipe" });
    return;
  } catch {
    // Shallow clones and fresh CI checkouts will not have upstream tags.
  }
  console.log(`fetching upstream tag ${tag}…`);
  try {
    git(["remote", "get-url", UPSTREAM_REMOTE], { stdio: "pipe" });
  } catch {
    git([
      "remote",
      "add",
      "upstream",
      "https://github.com/earendil-works/pi.git",
    ]);
  }
  try {
    git(["fetch", "--quiet", "upstream", "tag", tag, "--no-tags"]);
  } catch {
    fail(`could not fetch upstream tag ${tag}. Is it a real release?`);
  }
}

// Backport provenance is decided against upstream's own branch, so it has to be
// present before any backport can be trusted. CI checkouts never have it.
function ensureUpstreamBranchPresent() {
  try {
    git(["rev-parse", "-q", "--verify", UPSTREAM_BRANCH], { stdio: "pipe" });
    return;
  } catch {
    // Not fetched yet.
  }
  console.log(`fetching ${UPSTREAM_BRANCH}…`);
  try {
    git(["remote", "get-url", UPSTREAM_REMOTE], { stdio: "pipe" });
  } catch {
    git(["remote", "add", UPSTREAM_REMOTE, "https://github.com/earendil-works/pi.git"]);
  }
  try {
    git(["fetch", "--quiet", UPSTREAM_REMOTE, "main"]);
  } catch {
    fail(`could not fetch ${UPSTREAM_BRANCH}, which is required to verify ${UPSTREAM_BACKPORTS_FILE}.`);
  }
}

const tag = readPinnedTag();
ensureTagPresent(tag);

const backports = readBackports(REPO_ROOT);
if (backports.length > 0) ensureUpstreamBranchPresent();
const provenanceProblems = verifyBackportProvenance(git, backports);
if (provenanceProblems.length > 0) {
  fail(
    `${UPSTREAM_BACKPORTS_FILE} does not describe upstream history.\n\n` +
      provenanceProblems.map((problem) => `  • ${problem}`).join("\n"),
  );
}

const expected = buildExpectedTree(git, {
  baselineTag: tag,
  backports,
  frozenDirectories: FROZEN,
});
const pinDescription =
  backports.length === 0
    ? tag
    : `${tag} + ${backports.length} backport(s): ${backports.map((entry) => entry.sha.slice(0, 9)).join(", ")}`;

console.log(`checking ${FROZEN.length} frozen packages against ${pinDescription}\n`);

const drifted = [];
for (const pkg of FROZEN) {
  // Diff the tag against the WORKING TREE, not against HEAD. `git diff <tag> HEAD`
  // compares commits and is blind to uncommitted edits, so it would pass locally
  // and only fail later in CI — the worst possible place to learn. Omitting HEAD
  // makes git compare the tag to what is actually on disk, catching committed and
  // uncommitted drift alike. (This was a real bug here, caught by the negative
  // test that deliberately edits a frozen file; keep that test.)
  const diff = git(["diff", "--stat", expected, "--", pkg]);
  if (diff === "") {
    console.log(`  ✓ ${pkg}`);
  } else {
    console.log(`  ✗ ${pkg}`);
    drifted.push({ pkg, diff });
  }
}

if (drifted.length === 0) {
  console.log(`\n✓ all frozen packages match ${pinDescription}\n`);
  process.exit(0);
}

console.error(
  `\n✗ ${drifted.length} frozen package(s) differ from ${pinDescription}.\n\n` +
    "These packages are consumed, not forked (ADR 0001). They are present in\n" +
    "this repository only because Apex Code is a full-tree graft, and they must\n" +
    "stay byte-identical to upstream.\n",
);
for (const { pkg, diff } of drifted) {
  console.error(`--- ${pkg}\n${diff}\n`);
}
console.error(
  "To fix, pick one:\n" +
    `  • Revert the change:   git checkout ${tag} -- <path>\n` +
    "  • It belongs upstream: contribute it to github.com/earendil-works/pi\n" +
    `  • Upstream already fixed it but has not tagged a release: add the commit to\n` +
    `    ${UPSTREAM_BACKPORTS_FILE}. It must be reachable from ${UPSTREAM_BRANCH}.\n` +
    "  • It belongs in Apex Code: implement it above the boundary, in\n" +
    "    packages/coding-agent or packages/agent\n" +
    "  • The pin is stale: run scripts/apex/upstream-merge.sh, which updates\n" +
    "    .upstream-tag as part of the merge\n\n" +
    "Do not widen FROZEN in this script to make the failure go away. Moving a\n" +
    "package out of the frozen set is an ADR 0001 change, not a build fix.\n",
);
process.exit(1);
