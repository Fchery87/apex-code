# Phase 9 release hardening

**Status:** Not started — 0 of 6 tasks

This plan implements `docs/specs/2026-08-16-release-hardening.md`. Unlike Phase 8,
these tasks have no strict ordering dependency on each other — each is independently
verifiable — so they're numbered for tracking, not sequence. 9.1 is listed first
because it's the one correctness bug (misattributed data leaving the machine)
regardless of settings, and closing it early removes the temptation to let it linger
behind "cheaper" tasks.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 9.1 Remove broken install ping and dead analytics settings | Not started | — | `reportInstallTelemetry()` and its `pi.dev` call site removed; `enableAnalytics`/`trackingId` removed from `Settings`, `SettingsManager`, and settings-selector; provider-attribution headers retained but rebranded to Apex Code identity and no longer gated by the removed setting; typecheck clean (no dangling references); existing provider-attribution tests updated and passing |
| 9.2 Session-format migration test coverage | Not started | — | Fixture-driven tests for `migrateV1ToV2`, `migrateV2ToV3`, and the full v1→v3 chain, each asserting the migrated session's entries (messages, tool calls, usage) match hand-verified expected output, not just that migration doesn't throw |
| 9.3 Consolidated third-party license report | Not started | — | A script generates a non-empty report covering all workspace dependencies' licenses, runnable via `npm run` and wired into `release.yml`; fulfills `NOTICE`'s existing promise |
| 9.4 Cross-platform release verification | Not started | — | `release.yml` gains a macOS job verifying a clean `npm install --global` + version check, alongside the existing Ubuntu job, reusing its registry-propagation retry pattern |
| 9.5 User documentation and README correction | Not started | — | `README.md`'s status line corrected from "pre-alpha, Phase 0" to reality; a short `docs/user-guide.md` (install, first run, where to go next) exists and is linked from the README |
| 9.6 Security posture review and phase closure | Not started | — | `SECURITY.md` read against current code and corrected where it overclaims or underclaims; full `npm test` run characterized against the pre-existing failure set; typecheck/build/biome clean; roadmap Phase 9 row closed with the real SHA; this plan deleted per the lifecycle convention |

## Order changes

None expected. If task ordering changes during implementation, correct this section
rather than only noting it happened, per `AGENTS.md`.

## Shared implementation rules

- Write the failing test before each implementation slice; run the narrowest test
  file first.
- No new runtime dependency without checking it against this repo's stated hostility
  to heavy vendor deps (roadmap's "Explicitly not building," and Phase 8's own OTLP
  hand-rolling precedent) — a license-report generator should prefer reading
  `package-lock.json`/workspace `package.json` files directly over adding a
  dependency, if that's tractable; if not, justify the addition explicitly in the
  task's commit.
- Tests that construct session fixtures or touch settings storage use scratch
  directories; no test writes to the repo's own `.apex-code` state (`AGENTS.md` §
  Test discipline, carried forward from every prior phase).
- Removing `enableInstallTelemetry`/`enableAnalytics` must not make loading an
  existing user's config with those keys present throw or warn spuriously — verify
  `settings-manager.ts`'s unknown-key handling actually tolerates this, don't assume
  it.

## Task 9.1 — remove broken install ping and dead analytics settings

### Red

1. A test asserting `reportInstallTelemetry` is not exported/callable from
   `interactive-mode.ts` (or, if fully inlined, that no test-observable code path
   issues a request to `pi.dev`) — written to fail against the current tree first.
2. A test asserting `SettingsManager` has no `getEnableAnalytics`/`setEnableAnalytics`
   members after removal.
3. Update (not newly fail) `provider-attribution`'s existing tests to assert the new
   Apex Code-branded header values and that headers are no longer conditioned on the
   removed setting.

### Green

- Delete `reportInstallTelemetry()` and its call site in `interactive-mode.ts`.
- Delete `enableAnalytics`/`trackingId` from `Settings`, their getters/setters in
  `settings-manager.ts`, and the corresponding settings-selector menu entry.
- Rebrand `provider-attribution.ts` and `utils/pi-user-agent.ts` from `"pi"`/`"Pi"` to
  Apex Code's identity; remove the `isInstallTelemetryEnabled` gate from
  `getDefaultAttributionHeaders` (or keep the helper renamed/repurposed if still
  needed elsewhere — resolve during implementation, record the actual disposition in
  the deletion inventory).
- Confirm `src/core/telemetry.ts` is deleted or its remaining purpose is stated
  plainly in a doc comment, not left as an orphaned indirection.

### Refactor

Keep the attribution-header logic free of any telemetry-opt-out concept entirely —
it's provider-relationship metadata now, not something a privacy setting should gate
at all, matching how a User-Agent string isn't normally user-toggleable.

## Task 9.2 — session-format migration test coverage

### Red

1. A v1 fixture session file (hand-written or captured from a real pre-migration
   shape) driven through `SessionManager.open()`; assert it loads without throwing
   and its resulting entries match a hand-verified expected set — written to fail
   until the test itself exists (the migration code already passes; the test is what's
   new).
2. Same for a v2 fixture through `migrateV2ToV3`.
3. A test chaining v1 straight through to v3 in one load, asserting the two-step
   migration produces the same result as the two migrations run independently.

### Green

No production code changes expected — `migrateV1ToV2`/`migrateV2ToV3` already work.
If the red tests reveal an actual defect, fix it here and note the fix explicitly;
don't silently pass because the bar was never checked.

## Task 9.3 — consolidated third-party license report

### Red

A test (or CI-step assertion) that a license-report script exists, runs, and its
output includes at least one dependency from each workspace with a non-empty license
field — failing until the script exists.

### Green

Write `scripts/apex/generate-license-report.mjs`, reading dependency/license data
from `package.json`/lockfile across workspaces (prefer no new dependency; if one is
genuinely needed, justify it in the commit per the shared rules above). Wire it into
`release.yml` and add an `npm run` entry.

## Task 9.4 — cross-platform release verification

### Red

None in the TDD sense — this is CI configuration, verified by a real release run, not
a unit test. Record the intended macOS job design in the commit message and verify it
structurally (YAML validity, job depends on the same published version) before the
next real tagged release exercises it for real.

### Green

Add a `macos-latest` job to `release.yml` performing the same clean
`npm install --global` + version check as the existing Ubuntu job, depending on (not
duplicating) the publish steps.

## Task 9.5 — user documentation and README correction

### Green (docs-only, no red/green cycle)

Correct `README.md`'s status line. Write `docs/user-guide.md`: install, first run,
and pointers to permissions/sandbox/provider configuration — scoped, not a full
manual per the spec's non-goals. Link it from the README.

## Task 9.6 — security posture review and phase closure

### Green (docs-only plus final verification)

Read `SECURITY.md` against the current, verified state of the codebase (permission
gate, sandbox, credential handling) and correct any claim that's now stale in either
direction. Run the full closure verification (typecheck, build, biome, full test
suite characterized against the pre-existing failure set) and close out the roadmap
and this plan per the lifecycle convention.
