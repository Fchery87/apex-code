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
| 9.1 Remove broken install ping and dead analytics settings | Done | `5f1f007c5` | **Larger than scoped, two real findings beyond the original spec:** (1) the update-available check (`checkForNewPiVersion`) compared Apex Code's version against **Pi's**, unconditionally, on every startup — repointed at the npm registry's `next` tag for this package, all `Pi`-branded identifiers renamed, `pi-user-agent.ts` renamed to `apex-code-user-agent.ts`. (2) The "dead" analytics setting wasn't just inert — `first-time-setup.ts` actively asked every new user to consent to it, referencing a nonexistent `/privacy` command under Pi's name; removed, onboarding is theme-only now. `enableInstallTelemetry` replaced by an honestly-scoped `sendProviderAttribution` setting (default `true`) so a user who'd already opted out of attribution headers doesn't silently lose that choice. `provider-attribution.ts` and its 16-test suite (`sdk-openrouter-attribution.test.ts`, missed in the initial file-name grep) rebranded from `pi`/`Pi`/`pi.dev` to Apex Code identity. Two `pi.dev` references deliberately left alone and recorded in the spec's "Flagged, deliberately not touched": the remote model-catalog fetch and `/share`'s viewer URL — both real functional dependencies, not telemetry, requiring their own architectural decision. **Verified:** `npx tsgo --noEmit` clean; zero remaining references to any removed identifier (`grep` across `src/`+`test/`); 36 tests across 6 updated/new test files passing; broader regression sweep (116 tests, model-config/interactive-mode/args) unaffected. |
| 9.2 Session-format migration test coverage | Done | `49435b7a6` | **Scope corrected before implementing:** `test/session-manager/migration.test.ts` already existed (missed by the spec's first-pass `grep` for internal function names — it calls the exported `migrateSessionEntries` wrapper) and already covered v1→v2 tree structure and idempotency. This task filled the three real gaps it left: the v2→v3 `hookMessage`→`custom` rename (previously only mentioned in a comment, never exercised), the real `SessionManager.open()` load path where migration actually runs in production, and content-equivalence (message text, tool calls, tool results, usage) surviving migration, not just correct `id`/`parentId` linkage. **Verified, `test/session-manager/format-migration.test.ts` (4 tests):** a hand-written v1 JSONL fixture (no version, no id/parentId) migrates through the real file-load path with a user message, an assistant message with a tool call, and a tool-result message all preserving their content exactly, and the file is rewritten at version 3; a v2 fixture with a `hookMessage`-role entry migrates through the same real path with the rename applied and content preserved; a v3 fixture is confirmed **not** rewritten (no spurious migration). No production code changes were needed — the existing migration functions were already correct; this closes the coverage gap, not a bug. Full `session-manager/` suite: 108/108 passing, no regressions. |
| 9.3 Consolidated third-party license report | Done | `5e3299b0c` | **No new dependency** — `scripts/apex/generate-license-report.mjs` reads `license` fields directly from installed `node_modules/*/package.json` files (npm already puts them there), excluding this monorepo's own workspace packages (resolved via `realpath` into `packages/`, not hardcoded to the real repo's own path — the fixture tests inject their own `packages/` dir). Real run against this repo: 295 third-party packages, zero `UNKNOWN` licenses. **Two real bugs caught by the tests, not assumed away:** the workspace-exclusion check was hardcoded to the script's own repo location, so it silently failed to exclude a *fixture's* workspace packages during testing — fixed by deriving the packages root from the injected `nodeModulesDir` parameter; and the CLI entrypoint check (`import.meta.url === file://${process.argv[1]}`) failed unconditionally in this exact repository, because its path contains a space ("Coding Projects") that a raw `file://` template string doesn't percent-encode but `import.meta.url` does — fixed by comparing decoded paths via `fileURLToPath` instead of raw URL strings. **Verified, `scripts/apex/generate-license-report.test.mjs` (7 tests, `node --test`):** scoped-package handling, missing-license fallback to `UNKNOWN` rather than silent drop, workspace-package exclusion via a real symlink fixture, sort order, and both CLI modes (`--stdout`, file output). Wired into `release.yml` (new step + `actions/upload-artifact@v4.6.2`, SHA-pinned matching this repo's convention, verified against `npm run check:pinned-deps`) and `npm run generate:license-report`. **Incidental fix, found while locating where script tests are wired in:** `test:scripts`'s glob (`scripts/*.test.mjs`) never matched `scripts/apex/*.test.mjs` — `validate-release-tag.test.mjs`'s 3 tests were silently never run by `npm test`. Fixed the glob; confirmed those 3 tests now execute (7→10, then 17 with this task's own tests added). `NOTICE`'s forward-reference to Phase 9 replaced with the real mechanism. |
| 9.4 Cross-platform release verification | Done | uncommitted | A new `verify-macos-install` job runs on `macos-latest`, `needs: publish` (never re-runs the build/test/publish steps — a job that verified an install by also re-publishing would be a real hazard for a workflow with `id-token: write`), consumes the version via a new `publish` job output (`outputs.version`), and reuses the exact same registry-propagation retry loop as the Ubuntu job (duplicated intentionally, not extracted — the working Ubuntu step stays untouched to avoid any risk to the actual publish path). **Verified, extending `scripts/release-workflow.test.mjs` (1 new test) rather than only trusting YAML validity:** the new job depends on `publish`, runs on `macos-latest`, its commands contain no `npm publish` anywhere, and the whole-file count of `npm publish --access public --provenance --tag next` stays at exactly 2 (unaffected by the new job) — a real regression guard for a pipeline this session cannot execute end-to-end itself. `python3 -c "import yaml"` confirms valid syntax; `npm run check:pinned-deps` confirms the new `actions/upload-artifact`/`actions/setup-node` step pins pass this repo's own SHA-pinning check. Full `test:scripts`: 18/18. |
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

**Corrected scope, found before implementing:** `test/session-manager/migration.test.ts`
already exists and covers v1→v2 tree-structure assignment and idempotency via the
exported `migrateSessionEntries` wrapper — missed by the spec's first-pass `grep` for
internal function names. This task fills the three gaps that test leaves, not a
from-scratch migration test suite.

### Red

1. A fixture entry with `role: "hookMessage"` driven through `migrateSessionEntries`
   (or the real load path below), asserting it becomes `role: "custom"` — the v2→v3
   rename the existing test only mentions in a comment.
2. A v1-shaped fixture **JSONL file on disk** driven through the real
   `SessionManager.open()` (not calling `migrateSessionEntries` directly), asserting
   the file is rewritten to the current version and `getEntries()`/
   `buildSessionContext().messages` render the same message content, tool calls, and
   usage as hand-verified expected output — not just correct `id`/`parentId` linkage.
3. A v2-shaped fixture file through the same real load path, covering the
   `hookMessage`→`custom` rename specifically through production code, not the
   isolated unit call.

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
