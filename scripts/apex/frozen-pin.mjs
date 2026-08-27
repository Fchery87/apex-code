/**
 * What a frozen package is pinned to.
 *
 * ADR 0001's invariant is that no Apex-authored code lives inside a consumed
 * package. `.upstream-tag` alone expressed that as "byte-identical to a release",
 * which conflates authorship with upstream's *release cadence*. Those came apart on
 * 2026-08-25: upstream had authored the fix for a build break that models.dev caused
 * in `packages/ai` (e8c632ef6), and this repo could not take it purely because no tag
 * carried it. `main` stayed red while the only options were to wait on someone else's
 * release schedule, patch a frozen package, or work around it above the boundary.
 *
 * So the pin is a baseline tag *plus* an ordered list of upstream commits taken ahead
 * of release. Every byte in a frozen package still traces to a commit upstream wrote:
 * each backport must be reachable from `upstream/main`, and the expected content is
 * built by applying that commit's own diff, read from upstream's history at check
 * time. Nothing hand-written is trusted, which makes this a stricter statement of the
 * same rule rather than a hole in it -- it also catches a careless `.upstream-tag`
 * bump, which the old check could not.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const UPSTREAM_BACKPORTS_FILE = ".upstream-backports";
export const UPSTREAM_REMOTE = "upstream";
export const UPSTREAM_BRANCH = `${UPSTREAM_REMOTE}/main`;

/**
 * One upstream commit taken ahead of release.
 *
 * Full 40-character shas only: an abbreviation can become ambiguous as the object
 * database grows, and a pin that silently starts resolving to a different commit is
 * the one failure this file must not have.
 */
export function parseBackports(contents) {
	const backports = [];
	const lines = contents.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].replace(/#.*$/, "").trim();
		if (!line) continue;
		const [sha, ...subject] = line.split(/\s+/);
		if (!/^[0-9a-f]{40}$/.test(sha)) {
			throw new Error(
				`${UPSTREAM_BACKPORTS_FILE}:${index + 1}: expected a full 40-character upstream commit sha, got ${JSON.stringify(sha)}`,
			);
		}
		if (backports.some((entry) => entry.sha === sha)) {
			throw new Error(`${UPSTREAM_BACKPORTS_FILE}:${index + 1}: ${sha} is listed twice`);
		}
		backports.push({ sha, subject: subject.join(" "), line: index + 1 });
	}
	return backports;
}

export function readBackports(repoRoot) {
	try {
		return parseBackports(readFileSync(join(repoRoot, UPSTREAM_BACKPORTS_FILE), "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

function appliesInReverse(git, env, patch) {
	try {
		git(["apply", "--cached", "--check", "--reverse", "--whitespace=nowarn"], { env, input: patch, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function isAncestor(git, ancestor, descendant) {
	try {
		git(["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Reject anything whose content this repository could have authored.
 *
 * Retirement is decided by content in buildExpectedTree, not here. Upstream's release
 * tags sit on a different lineage from upstream/main -- v0.84.1 and main share only a
 * merge-base from nine months earlier -- so ancestry cannot answer "has this shipped
 * yet", and a staleness test built on it would silently never fire.
 */
export function verifyBackportProvenance(git, backports) {
	const problems = [];
	for (const backport of backports) {
		const label = `${UPSTREAM_BACKPORTS_FILE}:${backport.line}: ${backport.sha.slice(0, 9)}`;
		try {
			git(["cat-file", "-e", `${backport.sha}^{commit}`], { stdio: "pipe" });
		} catch {
			problems.push(`${label} is not a commit in this repository. Fetch ${UPSTREAM_BRANCH} and try again.`);
			continue;
		}
		if (!isAncestor(git, backport.sha, UPSTREAM_BRANCH)) {
			problems.push(
				`${label} is not reachable from ${UPSTREAM_BRANCH}. Only commits upstream actually authored can be ` +
					"backported; if upstream shipped this in a release, bump .upstream-tag instead.",
			);
		}
	}
	return problems;
}

/**
 * The tree the frozen packages must equal: the baseline tag with each backport's own
 * diff applied, in listed order, restricted to frozen paths.
 *
 * Restricted, because a backport is permission to take an upstream fix inside the
 * boundary -- not permission to import whatever else that commit touched. Applying the
 * diff rather than taking the file's post-image matters for the same reason: a file can
 * have moved on upstream since the baseline, and its snapshot would carry every
 * unrelated change with it.
 *
 * Built in a scratch index so the repository's own index is never touched.
 */
export function buildExpectedTree(git, { baselineTag, backports, frozenDirectories }) {
	if (backports.length === 0) return baselineTag;

	const scratch = mkdtempSync(join(tmpdir(), "apex-frozen-pin-"));
	const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
	try {
		git(["read-tree", baselineTag], { env });
		for (const backport of backports) {
			const patch = git(["diff", `${backport.sha}^`, backport.sha, "--", ...frozenDirectories], { trim: false });
			if (patch.trim() === "") {
				throw new Error(
					`${UPSTREAM_BACKPORTS_FILE}:${backport.line}: ${backport.sha.slice(0, 9)} touches no frozen package. ` +
						"A backport exists to carry a change across the ADR 0001 boundary; this one has nothing to carry.",
				);
			}
			try {
				git(["apply", "--cached", "--whitespace=nowarn"], { env, input: patch, stdio: "pipe" });
			} catch (error) {
				// A patch that will not apply forward but applies in reverse is already
				// present in the tree: upstream released the fix and the baseline now
				// carries it. That is a retired backport, not a conflict, and it is the
				// only signal that distinguishes the two -- so the entry reports itself
				// rather than relying on someone remembering a comment.
				const retired = appliesInReverse(git, env, patch);
				throw new Error(
					retired
						? `${UPSTREAM_BACKPORTS_FILE}:${backport.line}: ${backport.sha.slice(0, 9)} is already contained in ${baselineTag}. ` +
							"Delete this line; the baseline covers it now."
						: `${UPSTREAM_BACKPORTS_FILE}:${backport.line}: ${backport.sha.slice(0, 9)} no longer applies to ${baselineTag}.\n` +
							"  The baseline moved in a way that conflicts with it. Re-check whether upstream still needs backporting here.\n" +
							`  ${(error.stderr ?? "").toString().trim()}`,
				);
			}
		}
		return git(["write-tree"], { env });
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * `trim: false` matters for patch text: `git apply` rejects a patch whose trailing
 * newline has been stripped, reporting it as corrupt.
 */
export function createGit(repoRoot) {
	return (args, { trim = true, ...options } = {}) => {
		const output = execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", ...options });
		return trim ? output.trim() : output;
	};
}
