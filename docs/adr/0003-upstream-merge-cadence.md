# ADR 0003 — Upstream merge cadence, patch-surface ceiling, and abandonment tripwires

**Status:** Accepted (ceiling value pending Phase 0 baseline) · **Date:** 2026-08-08

Pi ships fast. At the time of this decision, one installed harness on this machine
tracked 0.83.0 while the predecessor extension layer was still built against 0.80.6 —
a drift of several releases accumulated without anyone choosing it. A fork with no
merge discipline does not decide to stop tracking upstream; it discovers, some months
later, that it already has. By then the divergence is too expensive to close and the
fork silently inherits maintenance of everything it forked.

This ADR decides how Apex tracks upstream, and — more importantly — what evidence
would justify stopping.

## Cadence

Apex merges upstream on **every upstream minor release**, not on a calendar. Merges
are batched only when releases land within days of each other; skipping a release to
"catch up later" is what produces unmergeable drift, so it is not an option
available by default.

Each merge is recorded in `docs/upstream-log.md` with: upstream version, date,
**conflicted hunk count**, files touched in forked code, and time spent. The hunk
count is the metric that matters — it is the only early signal that the fork is
drifting toward unmaintainable, and it is worthless unless recorded every time from
the first merge onward.

Patch surface is kept small by construction, per ADR 0001 and `CONTRIBUTING.md`:
forked files stay legible as a diff against upstream, and gratuitous restructuring of
forked code is reverted even when the change itself is an improvement.

## Ceiling

The Phase 0 upstream-merge rehearsal establishes the baseline hunk count for a
routine release. **The ceiling is set at 3× that baseline** and written into this ADR
as a concrete number once Phase 0 exits — this ADR is amended once, at that point,
and not renegotiated afterward.

Crossing the ceiling on a single merge is not itself a decision to stop. It triggers
a review: is the spike caused by one upstream refactor that will not recur, or by
Apex's own divergence compounding?

## Tripwires

Apex keeps tracking upstream until one of these fires. Each is checkable against
`docs/upstream-log.md` rather than argued from impression:

1. **Sustained ceiling breach** — three consecutive merges over the ceiling, with the
   cost attributable to Apex's divergence rather than a one-off upstream refactor.
2. **Upstream stalls** — no upstream release for two quarters, making the tracking
   relationship notional.
3. **Irreconcilable direction** — an upstream change that Apex must structurally
   reject to keep a shipped guarantee (a permission or sandbox invariant, or the
   session-format migration promise of ADR 0006), where no upstream contribution
   resolves it.

When one fires, the response is a spec — full fork of the affected package, upstream
contribution, or a shim — not an immediate cutover. The tripwire opens the question;
it does not answer it.

## Non-tripwires

Stated explicitly, because these are the arguments that will actually be made:

- "A merge was annoying this time." Single merges are noisy; that is why the tripwire
  requires three.
- "We would move faster if we owned it." ADR 0001 already weighed and rejected this.
- "We need a change inside `pi-ai` or `pi-tui`." The first response is an upstream
  contribution. A local patch to a consumed package converts it into an unmanaged
  fork without anyone deciding to, which is precisely what this ADR prevents.
