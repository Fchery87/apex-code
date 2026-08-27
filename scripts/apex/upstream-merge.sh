#!/usr/bin/env bash
#
# Take an upstream Pi release into Apex Code and report the cost.
#
# The conflict count is the metric ADR 0003's ceiling and tripwires read. This script
# prints it because a number nobody is shown is a number nobody records.
#
# Usage:  scripts/upstream-merge.sh v0.84.2
#
# Leaves the result staged and uncommitted so you can resolve conflicts, record the
# numbers in docs/upstream-log.md, and commit yourself. It never commits for you.
#
# ## Why this is not `git merge <tag>`
#
# The tags in this repository do not form one lineage. v0.84.0 and v0.84.1 arrived with
# the ADR 0001 graft, which rewrote every commit object: their trees are byte-identical
# to upstream's, their shas are not. v0.84.2 onward were fetched from upstream directly
# and sit on upstream's real history. The two meet only at a 2025-11-26 merge-base with
# roughly five thousand commits on each side.
#
# So `git merge v0.84.2` does not mean "take the next release". Measured on 2026-08-27
# it meant 1559 files and +308419/-49265, against 202 files and +10051/-4750 for the
# actual v0.84.1 -> v0.84.2 change. The previous version of this script would have
# produced that, and never got far enough to find out: `git fetch --tags` exits non-zero
# rather than clobber the graft-era tags, and `set -e` killed the run every time. The
# documented merge path has not worked since the graft, which is why this fork sat on
# v0.84.1 from 2026-08-07 with an abandoned half-merge parked on a branch.
#
# `git merge-tree --merge-base=<pin>` gives real three-way merge semantics with the base
# stated explicitly, so lineage never enters into it. The result is committed as content
# rather than as a merge: making v0.84.2's five thousand unrelated commits ancestors of
# main would be wrong, and .upstream-tag plus the frozen-package gate are what actually
# record which upstream revision the consumed packages sit at.

set -euo pipefail

target="${1:?usage: scripts/upstream-merge.sh <upstream-tag>   e.g. v0.84.1}"

# Paths Apex Code forks. Churn outside these is upstream's problem, not ours.
FORKED_PATHS=(packages/agent packages/coding-agent)

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "error: no 'upstream' remote. Add it:" >&2
  echo "  git remote add upstream https://github.com/earendil-works/pi.git" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree is dirty. Commit or stash before merging upstream." >&2
  exit 1
fi

# Never `--tags`: it exits non-zero rather than clobber the graft-era tags, and under
# `set -e` that ends the run before anything happens. Fetch only what is missing.
echo "==> fetching upstream"
if ! git rev-parse -q --verify "refs/tags/${target}" >/dev/null; then
  git fetch --quiet upstream "refs/tags/${target}:refs/tags/${target}" || true
fi

if ! git rev-parse -q --verify "refs/tags/${target}" >/dev/null; then
  echo "error: tag '${target}' not found after fetch." >&2
  echo "recent tags:" >&2
  git tag --list 'v*' | sort -V | tail -5 >&2
  exit 1
fi

pin="$(cat .upstream-tag 2>/dev/null || true)"
if [ -z "${pin}" ]; then
  echo "error: no .upstream-tag to advance from. This script moves the pin forward; it" >&2
  echo "       cannot reconstruct where the frozen packages currently sit." >&2
  exit 1
fi
if [ "${pin}" = "${target}" ]; then
  echo "error: .upstream-tag is already ${target}. Nothing to take." >&2
  exit 1
fi

echo "==> upstream churn ${pin} -> ${target}, in forked paths"
git diff --shortstat "${pin}" "${target}" -- "${FORKED_PATHS[@]}" || true

echo "==> merging ${pin} -> ${target}"
merge_output="$(git merge-tree --write-tree --merge-base="${pin}" HEAD "${target}")" || merge_status=$?
merge_status="${merge_status:-0}"

# 0 is a clean merge and 1 is a conflicted one. Anything else means merge-tree could not
# run at all, and continuing would advance the pin over a merge that never happened.
if [ "${merge_status}" -gt 1 ]; then
  echo "error: git merge-tree failed (exit ${merge_status}). Nothing has been changed." >&2
  exit 1
fi

# Parameter expansion, not `| head -1`: head closes the pipe after the first line, and on
# a merge whose conflict list exceeds the 64KB pipe buffer the write upstream of it takes
# SIGPIPE. Under `set -o pipefail` that ended the run at exit 141, after the churn summary
# had printed and before anything was applied, so it read as "the merge just stopped".
# v0.84.2's output fit in the buffer and hid this; v0.84.3's did not.
tree="${merge_output%%$'\n'*}"
# Between the tree oid and the first blank line, merge-tree lists one record per
# conflicted stage as `<mode> <oid> <stage>\t<path>`, so the same path repeats.
conflict_paths="$(printf '%s\n' "${merge_output}" | awk 'NR>1 && NF==0 { exit } NR>1 { print $4 }' | sort -u)"
messages="$(printf '%s\n' "${merge_output}" | awk 'seen { print } /^$/ { seen=1 }')"

git read-tree -u --reset "${tree}"

files="$(printf '%s' "${conflict_paths}" | grep -c . || true)"
forked_files="$(printf '%s\n' "${conflict_paths}" | grep -c -E "^($(IFS='|'; echo "${FORKED_PATHS[*]}"))/" || true)"
# Count the markers actually written into the tree rather than trusting the index:
# `git apply -3` leaves conflicted content without unmerged index entries, and an
# earlier version of this script reported zero conflicts for a merge that had in fact
# applied nothing at all.
hunks="$(git grep -c '^<<<<<<< ' -- $(printf '%s\n' "${conflict_paths}" | tr '\n' ' ') 2>/dev/null | awk -F: '{ total += $2 } END { print total + 0 }')"

echo
echo "────────────────────────────────────────────────"
echo "  taking             ${pin} -> ${target}"
echo "  conflicted hunks   ${hunks}"
echo "  conflicted files   ${files}  (${forked_files} in forked paths)"
echo "────────────────────────────────────────────────"
if [ -n "${messages}" ]; then
  echo
  printf '%s\n' "${messages}"
fi
# Advance the pin the frozen-package check reads. Doing this here rather than by
# hand is the point: if the pin lags the merge, check-frozen-packages.mjs compares
# the consumed packages against a stale tag and reports drift that is really just
# an unrecorded merge.
printf '%s\n' "${target}" > .upstream-tag
echo "updated .upstream-tag -> ${target}"

echo
echo "Next:"
echo "  1. Resolve conflicts."
echo "  2. Verify the ADR 0001 boundary held:"
echo "       node scripts/apex/check-frozen-packages.mjs"
echo "     A failure here means a consumed package was modified by the merge"
echo "     resolution — resolve those in upstream's favour, always."
echo "     If a .upstream-backports entry is now contained in ${target}, the check"
echo "     says so and names the line; delete it, the baseline covers it."
echo "  3. Record target / hunks / files / time in docs/upstream-log.md."
echo "  4. Check the count against the ADR 0003 ceiling. Three consecutive"
echo "     breaches attributable to our own divergence is a tripwire, not a"
echo "     bad week — see docs/adr/0003-upstream-merge-cadence.md."
echo "  5. Commit."

if [ "${hunks}" -eq 0 ] && [ "${files}" -eq 0 ]; then
  echo
  echo "note: clean merge. If Apex Code has not yet modified forked files, this"
  echo "      is zero by construction and is NOT a meaningful baseline."
fi
