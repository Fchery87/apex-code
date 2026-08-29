# Spec: Claims the repository cannot check

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Created | `2026-08-29` |
| Last updated | `2026-08-29` |
| Roadmap phase | `none — release-integrity follow-up` |
| Tracking issue/PR | pull request #63 |
| Compatibility posture | Preserves compatibility. No product source and no published artifact changes. `.github/workflows/release.yml` changes which npm dist-tag a future publication writes, which is a behaviour change for the next release rather than for anything already installed. The live registry is untouched by this change; moving `latest` off the deprecated `0.0.1-alpha.0` needs an authenticated maintainer and is recorded in `docs/release-governance-checklist.md`. Restoring sixteen excluded tests to `npm test` changes what CI runs, not what it ships. |

## Executive summary

Three of this repository's own claims were false, and in each case a mechanism that
could have caught them either did not exist or asserted the wrong thing. `npm install
apex-code` served a version this project had deprecated. Sixteen tests in an Apex-owned
package had not run in CI for twenty days. Sixteen of twenty specs reported a lifecycle
status their own roadmap contradicted. This spec fixes all three and adds the gates that
make each one a test failure rather than a discovery.

## Context and motivation

- `docs/adr/0026-semver-derived-npm-dist-tags.md` — the decision this implements for the
  release path.
- `.github/workflows/release.yml:174,195` before this change — both publish steps carried
  `--tag next`, unconditionally.
- `scripts/release-workflow.test.mjs:28,144` before this change — asserted exactly two
  occurrences of that literal command. The test guaranteed the defect, which is the same
  shape `2026-08-29-dependency-updates-that-can-merge` found in
  `scripts/apex/dependabot-config.test.mjs`. Twice in one week is a pattern rather than a
  coincidence.
- `package.json:32` before this change — `--exclude test/config.test.ts`, added by
  `93d5074da` whose subject is "test only Apex-owned packages". `packages/coding-agent`
  is such a package.
- `docs/specs/TEMPLATE.md:22` before this change — offered `Draft`, `Active`, and
  `Superseded`. None means the change shipped.
- `scripts/validate-docs-lifecycle.mjs` — read every spec and asserted one thing, that a
  Deletion inventory heading exists.

## Current state

Measured on 2026-08-29 against `6ff38bc72` and the live npm registry.

- **The unqualified install serves a deprecated build.** `npm view apex-code version`
  returns `0.0.1-alpha.0`. Its deprecation message reads "Stale prerelease. Use
  apex-code@next (0.0.1-alpha.2) or later." `apex-code-agent-core` matches. `latest` has
  never moved from the first publication, because nothing in the pipeline moves it.

- **Sixteen tests do not run.** `packages/coding-agent/test/config.test.ts` passes alone,
  16 of 16, in 16.7 seconds. It has been excluded from `npm test` since 2026-08-09.

- **Sixteen of twenty specs misreport themselves.** Eleven of fifteen phase-linked specs
  claimed `Draft` or `Active` against a roadmap phase marked landed, Phase 3's spec saying
  `Draft`. All five follow-up specs did the same. The cost is measured: the sandbox
  escalation spec read `Active` long after pull request #48 merged all seven of its units,
  and a reader acting on that field proposed work that was already done.

- **Seven ADRs are not in the roadmap's allocation table.** The roadmap states that
  "Numbers are allocated when an ADR is **written**", which makes that table the ledger.
  ADRs 0019 through 0024 are written and absent from it. The drift has stood since 0019.

- **One spec is linked from nowhere.** `2026-08-25-ember-tui-surface.md` had no roadmap
  row, so no gate could reach it whatever its status said.

## The problem

**1. A test can defend a defect.** `release-workflow.test.mjs` asserted the exact string
that made a stable release impossible. Anyone correcting the workflow got a red test and
reasonable grounds to conclude they were wrong. This is the second instance in a week.

**2. A gate that reads one field and ignores the rest teaches false confidence.** The docs
lifecycle validator ran on every spec and checked a heading. A reader who knows a validator
exists reasonably assumes the fields it walks past are checked.

**3. An allocation ledger nobody validates stops being a ledger.** Seven consecutive ADRs
went unregistered, so the table no longer answers the question it exists to answer, which
is which number is free.

## Goals

- [x] A prerelease publishes under `next` and a stable version under `latest`, derived from
      the validated version rather than hardcoded, asserted by
      `scripts/release-workflow.test.mjs`.
- [x] `npm test` excludes no test file, asserted by `scripts/package-test-config.test.mjs`
      against the script text rather than by inspection.
- [x] Every permanent spec carries exactly one standalone `**Status:**` line drawn from a
      closed vocabulary that includes a terminal value.
- [x] A spec and its roadmap row cannot disagree in **either** direction, asserted by
      `scripts/validate-docs-lifecycle.test.mjs`.
- [x] Every spec is reachable from `docs/roadmap.md`, so no spec sits outside the gate.
- [x] Every written ADR appears in the roadmap's allocation table, and every row in that
      table has a file.

## Non-goals

- [ ] **Moving the live `latest` dist-tag.** It needs registry credentials this repository
      does not hold and must not hold. The workflow governs future publications; the two
      `npm dist-tag add` commands are recorded in
      `docs/release-governance-checklist.md` for an authenticated maintainer.
- [ ] **Publishing a stable version.** This change makes one possible. Deciding that
      `0.0.1-alpha.10` is ready to become `1.0.0` is a separate judgement with its own
      evidence.
- [ ] **Rewriting the six documents that teach `apex-code@next`.** They are correct until a
      stable version exists. Changing them before that would make them wrong immediately.
- [ ] **Auditing each spec's history before setting `Landed`.** The roadmap marks every
      phase and follow-up landed, so the value is correct for all of them, and the new gate
      now holds each one to its roadmap row. A per-spec history audit would re-derive what
      the roadmap already records.
- [ ] **Gating ADR content.** The gate checks that a written ADR is registered, not that its
      status, phase column, or prose is right. Registration is machine-checkable; the rest
      is not.

## Proposed solution

Three units, independent, each landing in its own commit.

### A1 — Restore the excluded tests

| Component | Change | File(s) |
| --- | --- | --- |
| Script | Drop `--exclude test/config.test.ts` | `package.json` |
| Guard | Assert both workspaces present and no test file excluded | `scripts/package-test-config.test.mjs` (new) |

### A2 — One status vocabulary, gated both ways

| Component | Change | File(s) |
| --- | --- | --- |
| Template | Define `Landed`; require one standalone `**Status:**` line | `docs/specs/TEMPLATE.md` |
| Specs | Move twenty-eight permanent specs onto that form | `docs/specs/*.md` |
| Gate | Reject an unknown value, a missing or duplicate line, disagreement with the roadmap row in either direction, and a spec no roadmap row links | `scripts/validate-docs-lifecycle.mjs` |
| Ledger | Reject a written ADR absent from the roadmap table, and a table row with no file | `scripts/validate-docs-lifecycle.mjs` |

The two-way check is the point rather than a refinement. A gate that only rejects a spec
understating landed work leaves the dangerous direction open, because a spec claiming
`Landed` for work in progress reproduces the exact failure the gate exists to stop.

### A3 — Derive the dist-tag

| Component | Change | File(s) |
| --- | --- | --- |
| Tag | Read the validated version; prerelease to `next`, stable to `latest` | `.github/workflows/release.yml` |
| Test | Assert the derived expression and the semver branch | `scripts/release-workflow.test.mjs` |
| Decision | Record the policy | `docs/adr/0026-semver-derived-npm-dist-tags.md` |
| Runbook | The two commands that repair the live registry | `docs/release-governance-checklist.md` |

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `--exclude test/config.test.ts` in `package.json` | config | removed. It excluded an Apex-owned package's tests, which contradicts the commit that introduced it |
| The `Status` row in `TEMPLATE.md`'s metadata table | doc | superseded by a standalone `**Status:**` line, so one regular expression finds it in every spec |
| `Draft \| Active \| Superseded` as the whole vocabulary | doc | superseded. `Landed` is added because a spec that shipped had no value to take |
| `--tag next` hardcoded in both publish steps | config | superseded by the derived tag |
| `release-workflow.test.mjs`'s assertion of the literal `--tag next` | code | superseded by an assertion on the derived expression, plus a case for the semver branch |
| The claim that the docs lifecycle validator checks specs | implied doc | retired. It checked one heading; it now checks the status field, both directions of roadmap agreement, reachability, and ADR registration |

## Risks

**The status field is normalised by rule rather than by per-spec audit.** Every phase and
follow-up in `docs/roadmap.md` is marked landed, so `Landed` is correct for all of them,
and the two-way gate now holds each spec to its own row. The residual risk is a spec whose
roadmap row is itself wrong, which this change cannot detect and does not claim to. The
signal would be a roadmap row citing a commit that does not exist.

**`release.yml` is the one file where a mistake surfaces during a real publication.** CI
cannot exercise a publish. The mitigation is that the change is confined to one shell
branch and two `--tag` arguments, that no hardcoded `next` survives anywhere else in the
workflow including the post-publish verification steps, and that
`scripts/release-workflow.test.mjs` asserts both the derived expression and the branch that
produces it.

**Restoring sixteen tests lengthens the matrix.** The full `coding-agent` suite measured
355 files and 3,050 tests in 20m48s on the development machine with the exclusion still in
place. Sixteen tests taking 16.7 seconds is not a material addition, and the exclusion was
never a performance decision.

**Requiring every spec to be roadmap-linked adds a step to writing one.** That is the
intent. A spec no document reaches is a spec no gate can check, which is how
`2026-08-25-ember-tui-surface.md` sat outside every check this repository has.

## Verification

- `scripts/validate-docs-lifecycle.test.mjs` — the status vocabulary, both directions of
  roadmap agreement, reachability, and ADR registration.
- `scripts/release-workflow.test.mjs` — the derived tag and the semver branch.
- `scripts/package-test-config.test.mjs` — the root test command.
- `npm run check` for the lint, type, docs, and derived-artifact gates.
- `packages/coding-agent/test/config.test.ts` passes alone, 16 of 16.

The full `coding-agent` suite without the exclusion is settled by required CI rather than
here. The baseline with the exclusion is measured at 3,050 tests passing, and the restored
file passes in isolation, so the two facts bound the risk without closing it.

## Rollout

Small enough to implement directly; no separate plan document. Three commits, each with its
own test.

**Follow-up, with the evidence this change produces.** `latest` still points at
`0.0.1-alpha.0` until an authenticated maintainer runs the two commands in
`docs/release-governance-checklist.md`. Until then the workflow is correct and the registry
is not, and `npm view apex-code dist-tags --json` is the one-line check that says which.
