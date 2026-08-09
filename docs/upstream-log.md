# Upstream log

Fork point and every subsequent merge. The churn and hunk numbers here are what
ADR 0003's ceiling and tripwires read. Record every merge, from the first — a metric
nobody records is a metric that cannot fire.

## Upstream identity — resolved 2026-08-08

| Field | Value |
| --- | --- |
| Canonical remote | `https://github.com/earendil-works/pi.git` |
| Also resolves | `https://github.com/earendil-works/pi-mono.git` — same repo, identical refs; the old name, still redirecting. Published docs link to it; `package.json` and npm declare `pi`. Use `pi`. |
| Default branch | `main` |
| Tags | 314, `vMAJOR.MINOR.PATCH` |
| Latest release at fork time | `v0.84.1` |
| Fork point | **`v0.84.0`** — deliberately one release behind latest, so the immediately-following release supplies a real merge rehearsal instead of a synthetic one |

## Monorepo shape at v0.84.0

Ten packages, not the four ADR 0001 was written against:

| Package | Files | Relationship to Apex Code |
| --- | --- | --- |
| `packages/coding-agent` | 634 | **forked** |
| `packages/agent` | 81 | **forked** |
| `packages/ai` | 319 | consumed |
| `packages/tui` | 91 | consumed |
| `packages/client` | 23 | consumed — **not anticipated by ADR 0001** |
| `packages/protocol` | 17 | consumed — **not anticipated by ADR 0001** |
| `packages/server` | 31 | not used |
| `packages/session-backends` | 33 | not used |
| `packages/evals` | 19 | not used |
| `packages/telemetry` | 12 | not used |

`packages/coding-agent` declares runtime dependencies on **five** Pi packages, not
two: `pi-agent-core`, `pi-ai`, `pi-client`, `pi-protocol`, `pi-tui` (all `^0.84.0`).
ADR 0001 names only `pi-ai` and `pi-tui` as consumed and needs amending on this point.

## Measured upstream churn

The leading indicator for merge burden. Measured across one **patch** release:

| Range | Scope | Files | Insertions | Deletions |
| --- | --- | --- | --- | --- |
| `v0.84.0` → `v0.84.1` | forked paths (`agent`, `coding-agent`) | 57 | 1,770 | 279 |
| `v0.84.0` → `v0.84.1` | consumed paths (`ai`, `tui`) | 35 | 1,072 | 123 |

**Read this number before planning anything.** A single patch release rewrote ~2,000
lines across 57 files in the two packages Apex Code forks. Upstream moves faster than
the fork's divergence can safely ignore, which makes the ADR 0003 cadence — merge
every release, never batch to catch up later — a hard requirement rather than a
preference.

## On the conflict-hunk baseline

ADR 0003 sets its ceiling at 3× a baseline conflicted-hunk count, and the Phase 0
plan tasks this phase with producing it. **That baseline cannot be produced now, and
the plan was wrong to expect it.**

At the fork point Apex Code has zero divergence from upstream, so every merge is
conflict-free by construction. A rehearsal today yields a hunk count of 0, and a
ceiling of 3 × 0 = 0 is not a ceiling.

What Phase 0 can honestly establish is the churn table above: how much upstream moves
per release in the paths we fork. That is a real leading indicator, it is measurable
today, and it is recorded.

The conflicted-hunk baseline becomes measurable only once Apex Code has modified
forked files — realistically after Phase 2, the first phase that changes forked code
substantially. ADR 0003 is amended accordingly: the ceiling is set from the first
three merges that follow Phase 2, not from a Phase 0 rehearsal.

## Merge history

| Date | Upstream version | Conflicted hunks | Conflicted files | Files merged (forked paths) | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-08-08 | `v0.84.0` | — | — | — | Fork point. Full-tree graft, 1,353 files. |
| 2026-08-09 | `v0.84.1` | **1** | 1 (`AGENTS.md`) | 57 (+1,770 / −279) | First real rehearsal. **0 conflicts in forked code.** Total merge: 136 files, +3,976 / −992. |

### Two kinds of merge cost, tracked separately

The rehearsal separated a distinction the plan had conflated:

**Forked-code divergence — currently 0.** No conflicts in `packages/agent` or
`packages/coding-agent`, because Apex Code has not yet modified them. All 57 changed
files merged clean. This is the number ADR 0003's ceiling is about, and it stays
uninformative until Phase 2 changes forked code.

**Identity-file cost — currently 1 hunk per release, recurring.** `AGENTS.md`,
`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` exist in both trees with
entirely different content. Every upstream release that touches one of them conflicts,
forever, resolved by taking ours each time. `v0.84.1` touched `AGENTS.md`, so: 1 hunk.

This is a permanent tax, not divergence, and it must not be counted toward the ADR 0003
ceiling — otherwise the tripwire fires on upstream editing their own README. If it ever
grows beyond a few hunks per release, the fix is to move upstream's copies aside
(`AGENTS.upstream.md`) rather than to keep resolving them; at one hunk it is not worth
the churn.

**A third category, added 2026-08-09: deleted `.github/`.** Upstream's project
automation was removed wholesale, so every future upstream change to those paths
arrives as a delete/modify conflict, resolved with `git rm` each time. Expect a
handful per release. Also excluded from the ceiling.

The graft brought in ten upstream workflows, several actively hazardous on a
different repository: `issue-analysis.yml` runs an agent against issues using
Earendil org tokens, `publish-model-catalog.yml` writes to their R2 bucket,
`build-binaries.yml` publishes `pi-*` release artifacts, and four gate/triage
workflows enforce a contribution process Apex Code does not run. Deleting was
correct rather than neutering: `.github/` is upstream's **operations**, not their
product. The packages/ argument for keeping paths mergeable does not apply, because
we want none of their CI. `.github/APPROVED_CONTRIBUTORS` and `ISSUE_TEMPLATE/` went
with them — the first was orphaned once its enforcing workflow was gone, and the
templates pointed users at Pi's Discord and Pi's contribution rules.
