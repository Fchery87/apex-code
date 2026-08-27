#!/usr/bin/env bash
#
# Merge an upstream Pi release into Apex Code and report the merge cost.
#
# The conflicted-hunk count is the metric ADR 0003's ceiling and tripwires read.
# This script prints it because a number nobody is shown is a number nobody records.
#
# Usage:  scripts/upstream-merge.sh v0.84.1
#
# Leaves the merge staged and uncommitted so you can resolve conflicts, record the
# numbers in docs/upstream-log.md, and commit yourself. It never commits for you.

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

echo "==> fetching upstream"
git fetch --quiet upstream --tags

if ! git rev-parse -q --verify "refs/tags/${target}" >/dev/null; then
  echo "error: tag '${target}' not found after fetch." >&2
  echo "recent tags:" >&2
  git tag --list 'v*' | sort -V | tail -5 >&2
  exit 1
fi

merge_base="$(git merge-base HEAD "${target}" || true)"

echo "==> upstream churn since our merge base, in forked paths"
if [ -n "${merge_base}" ]; then
  git diff --shortstat "${merge_base}" "${target}" -- "${FORKED_PATHS[@]}" || true
else
  echo "  (no common ancestor — first graft)"
fi

echo "==> merging ${target}"
git merge --no-commit --no-ff "${target}" || true

# Conflicted hunks: the real cost signal. Counted from the unmerged diff, which
# renders conflict regions as hunks.
hunks="$(git diff --diff-filter=U | grep -c '^@@' || true)"
files="$(git diff --name-only --diff-filter=U | wc -l | tr -d ' ')"
forked_files="$(git diff --name-only --diff-filter=U -- "${FORKED_PATHS[@]}" | wc -l | tr -d ' ')"

echo
echo "────────────────────────────────────────────────"
echo "  target             ${target}"
echo "  conflicted hunks   ${hunks}"
echo "  conflicted files   ${files}  (${forked_files} in forked paths)"
echo "────────────────────────────────────────────────"
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
