# Spec: <title>

> File as `docs/specs/YYYY-MM-DD-<slug>.md` — dated like `docs/plans/` and
> `docs/research/`, not numbered like `docs/adr/`. A spec is written *before* the
> change; delete this blockquote when you copy the template.

**Status:** Draft

A spec sits between an ADR and a plan, and substitutes for neither. An ADR
(`docs/adr/`) records one settled decision, in a few paragraphs, with no lifecycle of
its own. A plan (`docs/plans/`) is a task-by-task execution breakdown with a
`**Status:**` line, deleted on completion. A spec is the design document for a
nontrivial change: what problem it solves, what it deliberately will not do, and —
the part neither other format carries — what the change makes obsolete. It stays in
the repo after implementation as the record of what was decided and why. If an
irreversible decision surfaces partway through implementation, write an ADR for it
and cite it from Rollout; do not fold it in here.

## Metadata

| Field | Value |
| --- | --- |
| Author | `<name>` |
| Created | `YYYY-MM-DD` |
| Last updated | `YYYY-MM-DD` |
| Roadmap phase | `<phase number and name, or "none">` |
| Tracking issue/PR | `<link, or "none">` |
| Compatibility posture | `<required — see below>` |

**Compatibility posture** is not optional and not a one-word answer. State plainly
whether this is a **clean break** (old callers, config, or behavior stop working, no
shim) or **preserves compatibility** (old and new coexist — for whom, for how long),
and why that posture beat the other one. Apex Code is distributed, so anything touching
the session format, settings schema, or CLI surface carries a real obligation to
users; say what it is. A spec with no stated posture forces every reader to
reverse-engineer it from the diff.

A spec must contain exactly one standalone `**Status:**` line near its main heading. Use `Draft` while the design is under review, `Active` while it is being
implemented, `Landed` once the change is shipped, and `Superseded` only when a later
spec replaces it. The lifecycle validator enforces this vocabulary and checks that
roadmap rows marked landed link only to `Landed` specs.

## Executive summary

2–4 sentences. Someone who reads only this section should know what changes and why.
Do not restate the metadata; say what the change *is*.

## Context and motivation

What prior work this builds on or supersedes, with real paths — not a narrative
recap. Prefer:

- `docs/adr/NNNN-<slug>.md` — a settled decision this extends, revisits, or depends on.
- `docs/roadmap.md` — the phase this belongs to and the exit criterion it serves.
- `docs/plans/YYYY-MM-DD-<slug>.md` — a plan this grew out of. Completed plans are
  deleted; cite `git show <commit>:docs/plans/<name>` if the content itself matters.
- `docs/research/YYYY-MM-DD-<slug>.md` — prior investigation this acts on. **This is
  the only permitted channel for ideas observed in unlicensed sources** (ADR 0002).

If none apply, say so explicitly rather than leaving the section thin.

## Current state

What exists today — the "before," on the record so the diff has a baseline. Cite
`file:line` where it clarifies more than prose. Description, not argument.

For changes to forked code, say whether the current state is upstream Pi's behavior
or something Apex Code already changed. The merge cost differs (ADR 0003).

## The problem

What is concretely wrong or missing — a defect, a gap, a cost that compounds. Not "X
could be better" but the failure mode, ideally with the trigger that reproduces it.
If there is no concrete problem, this is not yet spec-worthy.

## Goals

Each goal independently verifiable against the finished change — checkable by someone
else pointing at a test, a log line, or a diff. "Improve reliability" is not
checkable; "the gate no longer fires on template-generated criteria" is.

- [ ] `<goal, phrased so it is checkable>`
- [ ] `<goal>`

## Non-goals

Carries as much weight as Goals. State what this will **not** do, and why — not "out
of scope" with no reasoning. An undefended non-goal invites scope creep the moment
someone asks "while we're in here…".

- [ ] `<explicitly declined, with the reason>`

## Proposed solution

The mechanism, not just the intent. For more than one moving part, a table is faster
than prose:

| Component | Change | File(s) |
| --- | --- | --- |
| `<name>` | `<what changes>` | `<path>` |

If this touches a load-bearing seam named in `docs/architecture/overview.md`
(`beforeToolCall`, `ruleContent`, `transformContext`, evidence capture), say how the
seam's invariant is preserved.

## Deletion inventory

What this makes obsolete. **Required even when the answer is "nothing."**

| Item | Type | Disposition |
| --- | --- | --- |
| `<path or behavior>` | code \| config \| doc \| behavior | removed / retired / superseded by `<new thing>` |

If nothing is deleted: "Nothing existing is removed — this is additive. `<one
sentence on why that is the right shape here, not a hedge>`."

## Risks

The specific failure mode this design invites, and the signal that would surface it —
a test, a log line, a user report. Not a generic risk register.

## Verification

How the finished change is proven. Name the tests, and — if this serves a roadmap
phase gate — the metric and threshold from `docs/roadmap.md`, measured against the
replay corpus.

## Rollout

State which applies, and why:

- Small enough to implement directly, no separate plan doc.
- Needs `docs/plans/YYYY-MM-DD-<slug>.md` because `<multi-phase / many files / needs
  its own status tracking>`.
- Needs an ADR for one decision inside it because `<irreversible or contested>`; cite
  it here once written.
