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

| Date | Upstream version | Conflicted hunks | Files touched (forked) | Time | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-08-08 | `v0.84.0` | — | — | — | Fork point. No divergence yet. |
