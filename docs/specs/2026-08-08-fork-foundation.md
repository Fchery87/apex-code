# Spec: fork foundation

## Metadata

| Field | Value |
| --- | --- |
| Author | Fchery87 |
| Status | `Draft` |
| Created | 2026-08-08 |
| Last updated | 2026-08-08 |
| Roadmap phase | 0 — Fork foundation |
| Tracking issue/PR | none |
| Compatibility posture | **Not applicable — greenfield.** Apex Code has no users, no released version, and no published format. Nothing can break. This is the only phase where that is true, and it is why the format-defining work (session identity, config directory, package name) belongs here rather than later: after Phase 9 every one of these is a compatibility promise (ADR 0006). |

## Executive summary

Stand up Apex Code as a working fork of `pi-coding-agent` and `pi-agent-core` that builds,
tests, releases, takes upstream changes, and can measure itself. The measurement
piece — a replay corpus of scrubbed real sessions plus a headless metrics runner — is
the load-bearing deliverable: every later phase gate in `docs/roadmap.md` is stated as
a number against it, and without it those gates are unenforceable.

## Context and motivation

- `docs/roadmap.md` § Phase 0 — the phase this implements, and the gates downstream
  phases will read.
- `docs/adr/0001-fork-boundary.md` — which packages are forked and which consumed.
- `docs/adr/0002-clean-room-sources.md` — the provenance constraint on all code here.
- `docs/adr/0003-upstream-merge-cadence.md` — the merge process this phase rehearses
  and baselines. Its ceiling value is filled in from this phase's output.
- `docs/research/2026-08-08-harness-comparative-review.md` — why the fork boundary
  falls where it does (Findings 1, 5).

## Current state

Nothing exists but documentation. There is no repository, no package, no build.

Upstream at time of writing: `github.com/earendil-works/pi`, packages
`packages/coding-agent` and `packages/agent`, published as
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-agent-core`. Version
`0.80.6` is installed locally; `0.83.0` is the latest version observed in another
installation. Upstream builds with `tsgo`, tests with `vitest`, requires Node
≥ 22.19.0, and produces an optional single-file binary via `bun build --compile`.

Note: upstream documentation links reference a `pi-mono` repository path while
`package.json` declares `pi`. The discrepancy is unresolved and Task 0.2 confirms the
real remote before anything is cloned.

Source material for the replay corpus exists as real session transcripts in three
installed Pi-lineage harnesses on this machine. They contain live credentials and
absolute personal paths.

## The problem

Three failure modes, each of which has already happened to comparable projects:

1. **Unmeasurable gates.** The roadmap states Phase 3 exits on "median context tokens
   at turn 20 down ≥40%." With no corpus and no metrics runner, that sentence is
   decoration. Every phase after it inherits the same problem, and the project
   degrades into shipping on impression.
2. **Silent upstream drift.** A fork that has never rehearsed a merge does not know
   what one costs. The predecessor layer sat on `0.80.6` while another installation
   tracked `0.83.0` — drift nobody chose. ADR 0003 requires a baseline hunk count;
   only an actual merge produces one.
3. **A release path first exercised at release time.** Deferring packaging to Phase 9
   means the first real attempt happens under pressure, against nine phases of
   accumulated assumptions.

## Goals

- [ ] `apex-code` builds, typechecks, lints, and tests green in CI on Linux, macOS, and Windows.
- [ ] `npx <package>@<version>` (or the equivalent published artifact) runs a
      pre-alpha binary that starts, accepts a prompt, and completes one turn against
      a configured provider.
- [ ] One real upstream release is merged end-to-end and its conflicted hunk count is
      recorded in `docs/upstream-log.md`.
- [ ] `docs/adr/0003-upstream-merge-cadence.md` is amended with a concrete ceiling
      derived from that baseline.
- [ ] The replay corpus runs headless and emits identical metrics across two
      consecutive runs on the same input.
- [ ] No corpus fixture contains a credential, an absolute personal path, or a
      hostname. Enforced by a test, not by review.
- [ ] `apex-code --version` reports the Apex Code version and the upstream fork point.

## Non-goals

- [ ] **No behavior changes to the forked code.** Phase 0 ships upstream behavior
      under a new name. Mixing a rename with functional change makes the first
      upstream merge unreadable, and readability of that first merge is the entire
      point of the rehearsal.
- [ ] **No permission system, sandbox, eviction, or new tools.** Those are Phases 2–4
      and depend on seams this phase only inherits.
- [ ] **No renaming or restructuring of forked internals** beyond what the package
      rename strictly requires. Every cosmetic change is permanent merge cost
      (ADR 0001, ADR 0003).
- [ ] **Directory paths are NOT renamed.** `packages/coding-agent` and
      `packages/agent` keep their upstream paths forever. Only the npm names, the
      binary, and the config directory change. Renaming `packages/coding-agent` to
      `packages/apex-code` would relocate 634 files and make every future merge
      depend on git rename detection across the whole package — against an upstream
      that moves 57 files per *patch* release. It is the single most expensive
      change available to us, it buys nothing a user can see, and it is already
      prohibited in principle by ADR 0001. Directory paths are internal; the npm
      name and the binary are the identity users interact with.
- [ ] **No trajectory-based model evaluation suite.** Deliberately declined: the
      predecessor project built one that called no model and fabricated its numbers,
      and deleted it. The replay corpus is the honest, affordable instrument.
      Re-proposing an eval suite must re-open that framing decision, not resume a
      paused task.
- [ ] **No `pi-ai` or `pi-tui` changes.** Dependencies, per ADR 0001.

## Proposed solution

| Component | Change | Path |
| --- | --- | --- |
| Repo skeleton | Workspace with two forked packages; license, notice, docs | repo root |
| `apex-code-agent-core` | Fork of `packages/agent`. npm name only; **directory path unchanged** | `packages/agent` |
| `apex-code` | Fork of `packages/coding-agent`. npm name, binary `apex-code`, config dir `~/.apex-code/`; **directory path unchanged** | `packages/coding-agent` |
| Upstream tracking | `upstream` git remote, merge script, hunk-count log | `scripts/upstream-merge.sh`, `docs/upstream-log.md` |
| CI | typecheck, lint, test, build on three platforms | `.github/workflows/ci.yml` |
| Release | Tagged publish producing an installable artifact | `.github/workflows/release.yml` |
| Corpus scrubber | Redacts credentials, paths, hostnames from recorded sessions | `scripts/scrub-session.ts` |
| Replay runner | Replays a corpus session offline, emits metrics as JSON | `packages/coding-agent/src/testing/replay/` |
| Metrics schema | Context tokens at turn N, system-prompt tokens, tool calls, cache hit rate, wall time, cost | same |

**Fork mechanics.** Clone upstream with full history, add it as an `upstream` remote,
and keep Apex Code's history rooted in it. Merging then remains a normal `git merge`
rather than a manual diff-and-patch exercise, which is what makes the ADR 0003 hunk
count meaningful.

**Replay determinism.** The runner substitutes a recorded-response provider for the
live one, so no network call occurs and token accounting is reproducible. This is the
only place Phase 0 adds a seam rather than inheriting one, and it uses the existing
provider registration path rather than modifying `pi-ai` (ADR 0001).

**Scrubbing is enforced, not reviewed.** A test scans every corpus fixture for
credential-shaped strings, absolute home paths, and hostnames, and fails the build on
a hit. The incidental finding in the research doc — a live key sitting in cleartext in
two installed configs — is exactly the outcome review-based hygiene produces.

## Deletion inventory

Nothing existing is removed — Apex Code has no prior state. Two things are *retired by
supersession* from the predecessor project, recorded so they are not carried forward
by habit:

| Item | Type | Disposition |
| --- | --- | --- |
| Thanos as a standalone extension layer on stock Pi | behavior | Superseded. Its evidence model moves into Apex Code core in Phase 7 (ADR 0007); its policy layer is re-hosted as a bundled Apex Code extension. Not ported in Phase 0. |
| Any self-measurement that cannot fail | behavior | Retired by policy. The replay corpus replaces impression-based reporting; a metric with no failure mode is not added. |

## Risks

**The corpus gets skipped as "not real work."** It looks like test infrastructure and
it is the highest-leverage item in the phase. The mitigation is structural: it is a
goal, its scrubbing is enforced by a test, and the phase does not exit without two
identical consecutive runs.

**Determinism is harder than expected.** Timestamps, ordering of concurrent tool
execution, and token estimator drift can all make two runs differ. The signal is the
two-run check failing; the response is to pin or exclude the nondeterministic field
explicitly and record why, not to loosen the check.

**The rename touches more than expected.** Config directory, session paths, binary
name, and package identity all thread through the forked tree, and each edit is
permanent merge cost. If the rename's own hunk count is large, that is worth knowing
before Task 0.2's baseline is interpreted — record them separately.

**Corpus sessions are personal.** They are real transcripts of real work. Scrubbing
handles credentials and paths mechanically, but content may still be sensitive.
Review what goes in, and prefer sessions from throwaway projects where the coverage
is equivalent.

## Verification

- CI green on three platforms: typecheck, lint, test, build.
- `docs/upstream-log.md` contains one real merge with a recorded hunk count; ADR 0003
  amended with the derived ceiling.
- Replay runner produces byte-identical metrics JSON across two consecutive runs on
  the same corpus (asserted by test).
- Scrubbing test passes against every fixture, and fails when a known-bad fixture is
  introduced deliberately — a scrubber that has never rejected anything is unproven.
- Published artifact installs from a clean machine and completes one turn.

## Rollout

Needs `docs/plans/2026-08-08-fork-foundation.md`: multi-step, spans repo setup, two
forked packages, CI, release, and the corpus, and needs its own status tracking
across sessions.

ADR 0003 is amended (not superseded) at the end of Task 0.2, once the baseline hunk
count exists. No new ADR is expected from this phase; if the replay runner requires a
change inside `pi-ai` rather than above it, that is an ADR 0001 boundary question and
must stop for a decision rather than be absorbed here.
