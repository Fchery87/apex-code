# Spec: Release hardening

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Status | `Active` |
| Created | 2026-08-16 |
| Last updated | 2026-08-16 |
| Roadmap phase | `9 — Release hardening` |
| Tracking issue/PR | none |
| Compatibility posture | **Preserves compatibility, with one deliberate removal.** Session-format migration test coverage, license reporting, and cross-platform release verification are purely additive. The one clean break: `reportInstallTelemetry()`'s network call and the inert `enableAnalytics`/`trackingId` settings are removed outright — see *The problem* and *Non-goals*. No session-format version bump, no settings-schema break otherwise. The project remains pre-alpha; this phase does not cut a graduating release. |

## Executive summary

Phase 9 is mostly verification and repair, not new capability — the same shape Phase
8 turned out to have. `SECURITY.md`, `NOTICE`, and JSONL session-format auto-migration
(v1→v2→v3) already exist, inherited or already written; what's missing is test
coverage for the migration, a working consolidated license report (`NOTICE` already
promises one "as part of the release process" — it doesn't exist), cross-platform
release-artifact verification (today: Ubuntu only), and a real fix to a verified bug:
the inherited install-ping reports Apex Code's version to **Pi's** telemetry endpoint
under Pi's own brand string, regardless of any opt-in setting. This spec removes that
ping and its dead-code sibling rather than inventing new Apex-directed telemetry
infrastructure, matching the phase's chosen scope: harden what exists, do not expand
what Apex Code collects, do not cut a public release.

## Context and motivation

- `docs/roadmap.md` § Phase 9 — the phase this serves: versioned releases and update
  path (hardened, not new), install on all supported platforms, session-format
  migration, user documentation, security disclosure process, opt-in-only telemetry,
  third-party attribution.
- `docs/adr/0005-sandbox-boundary-guarantees.md` — "Windows remains unsupported."
  "All supported platforms" in this spec means Linux and macOS; Windows is a standing
  exclusion, not a new decision this phase makes.
- `docs/adr/0006-session-format-and-durable-state.md` — JSONL stays the session of
  record; this phase tests, not changes, that commitment's migration path.
- `NOTICE` (repo root) — already states a "consolidated dependency license report is
  generated as part of the release process (see docs/roadmap.md, Phase 9)." No such
  report exists yet; this spec is where that promise is kept.
- Prior conversation in this session verified, by reading source rather than
  assuming, the exact behavior of `enableInstallTelemetry` and `enableAnalytics` —
  see *Current state* and *The problem*.

## Current state

Verified against the tree at `452d8fa99`, not recalled.

| Fact | Evidence |
| --- | --- |
| `SECURITY.md` already exists and is substantive | Repo root, 55 lines: private disclosure via GitHub security advisories, explicit in/out-of-scope boundary, "Not a security boundary" section for project trust, guidance for running untrusted work. |
| `NOTICE` already exists and covers upstream/third-party attribution | Repo root: Pi's MIT notice, frozen-package list, and a stated (unfulfilled) promise of a consolidated dependency license report "generated as part of the release process." |
| Session format auto-migration already exists | `session-manager.ts`: `migrateV1ToV2` (`:260`), `migrateV2ToV3` (`:289`), version-gated at load (`:316-317`). `CURRENT_SESSION_VERSION = 3` (`:32`), unchanged by any Apex Code phase so far — no new migration is owed, only test coverage for the existing one. |
| That migration has **partial** test coverage — narrower than an initial `grep` for the function names suggested | **Correction, found before implementing 9.2:** `grep -rl "migrateV1ToV2\|migrateV2ToV3"` returns nothing because `test/session-manager/migration.test.ts` calls the exported `migrateSessionEntries` wrapper, not the internal functions by name — a real, pre-existing test this spec's first pass missed. It covers v1→v2 tree-structure assignment (`id`/`parentId`) and idempotency (already-migrated entries left alone). It does **not** cover: the v2→v3 `hookMessage`→`custom` role rename (only mentioned in a comment, never exercised — no fixture entry has `role: "hookMessage"`); the real `SessionManager.open()` load path, where migration actually runs in production (`session-manager.ts:964`) and rewrites the file; or that migrated entries render the same content (message text, tool calls, usage) as the source, versus merely having correct `id`/`parentId` linkage. Task 9.2 fills these three specific gaps rather than writing migration tests from nothing. |
| The release pipeline verifies install on Ubuntu only | `.github/workflows/release.yml`: single job, `runs-on: ubuntu-latest`. It publishes both packages, then does a real clean-registry `npm install --global` and version check — but only on one of the two supported platforms. |
| README is stale | `README.md:5`: "Status: pre-alpha, Phase 0." Phases 0–8 are landed. The document a stranger reads first states a phase eight behind reality. |
| `enableInstallTelemetry` (default `true`) gates a real network call, and that call is a verified bug independent of its opt-in status | `interactive-mode.ts:1198-1215`, `reportInstallTelemetry()`: fires once per detected version upgrade (not every startup), `GET https://pi.dev/api/report-install?version=<VERSION>`, `User-Agent: pi/<VERSION> (<platform>; <runtime>; <arch>)` (`utils/pi-user-agent.ts:1-4`, hardcoded `"pi/"` prefix). `VERSION` is Apex Code's own `package.json` version (`config.ts:492`). Unmodified upstream Pi code: the endpoint, and the User-Agent brand string, were never updated for the fork. Today, every Apex Code upgrade reports itself to Pi's telemetry as a Pi install, under Apex Code's real version number — wrong regardless of consent, since it's data sent to a domain Apex Code doesn't own and provides Apex Code no value. |
| The same setting also gates provider-attribution HTTP headers, a materially different and more defensible mechanism | `provider-attribution.ts:36-65`: `HTTP-Referer`, `X-OpenRouter-Title`, `X-BILLING-INVOKE-ORIGIN`, User-Agent headers attached to requests already going to the user's own configured LLM provider (OpenRouter/NVIDIA NIM/Cloudflare), for that provider's own billing-origin attribution — never sent to a third party. Also still hardcoded `"pi"`/`"Pi"`. |
| `enableAnalytics`/`trackingId` ("opt-in analytics") is dead code — **and actively presented to every first-time user as if it worked** | `getEnableAnalytics()` (`settings-manager.ts:1002`) has zero production consumers anywhere in the tree — only its own getter/setter and `test/first-time-setup.test.ts`, which asserted the *stored preference*, never that anything is sent. **Found during implementation, beyond this row's original scope:** `first-time-setup.ts`'s onboarding dialog has a whole second step asking every new user "Opt-in to anonymous usage data sharing?" with the text "This helps us to better debug, reproduce, and resolve issues and bugs within Pi. You can observe what is shared using /privacy" — `/privacy` does not exist anywhere in the tree (`grep` confirms zero matches), and even the copy says "Pi," not Apex Code. This is not inert-and-forgotten; it is an active prompt asking for consent to something that never happens, on every fresh install. |
| No mechanism sends data to the Apex Code project today | Following from the two rows above: there is currently no working or broken Apex-directed telemetry of any kind — only a misdirected Pi ping and an inert dead switch. |
| **A second, more severe instance of the same root cause: the update-available check compares against the wrong project's version, on every interactive startup, unconditionally.** | `interactive-mode.ts:1024`, `checkForNewPiVersion(this.version)`, called on every interactive session start (fire-and-forget, no settings gate at all — not even `enableInstallTelemetry`). `version-check.ts:5`: `LATEST_VERSION_URL = "https://pi.dev/api/latest-version"`. This returns **Pi's** latest published version, compared against Apex Code's own `this.version` (`config.ts:492`, currently `0.0.3`) via `isNewerPackageVersion`. Since Pi (at `v0.84.x` per `docs/upstream-log.md`) and Apex Code (`0.0.x`) are on entirely unrelated version sequences, this comparison is close to always true — every Apex Code user, on every startup, is likely shown a false "Update Available" banner (`interactive-mode.ts:4108`, `showNewVersionNotification`) naming **Pi's** version number and linking to `https://pi.dev/changelog` (`:4111`), a page with no relationship to Apex Code's actual `packages/coding-agent/CHANGELOG.md`. Confirmed via `npm view apex-code dist-tags --json`: the real, already-published, already-relevant data (`{"next":"0.0.1-alpha.1","latest":"0.0.1-alpha.0"}`) sits on the npm registry Apex Code already publishes to — no new endpoint is needed to fix this, only pointing the existing check at the right one. |

## The problem

**P1 — A verified misattribution bug, unconditional on any settings.** Every Apex
Code install that detects a version upgrade reports itself to Pi's telemetry
endpoint as a Pi install. This is not a privacy question first; it is a correctness
bug: the data is wrong (claims to be software it is not) and sent to a party with no
relationship to it (Apex Code does not operate `pi.dev`).

**P1a — The same root cause, worse: a false update notification on every startup,
with no settings gate at all.** `checkForNewPiVersion` runs unconditionally (no
opt-out exists, unlike the install ping) on every interactive session start, compares
Apex Code's version against Pi's, and — because the two projects' version sequences
are unrelated and Pi ships far more often (Phase 0 measured one Pi patch release
moving 57 files) — will show a false "Update Available" banner naming Pi's version
number to most users most of the time, linking to Pi's changelog. This directly
undermines the roadmap's own "versioned releases and update path... hardened here"
scope: the update path currently cannot tell a user whether a real Apex Code update
exists.

**P2 — A dead setting invites false confidence.** A user who enables "opt-in
analytics" in good faith, expecting it to do something, is enabling nothing. The
setting's existence implies a capability that was never built.

**P3 — `NOTICE` makes a promise the repo does not keep.** It states a consolidated
license report is "generated as part of the release process." No script, no CI step,
and no such report exists anywhere in the tree.

**P4 — The migration path this phase's own exit criterion names is only partially
verified.** "Preserves and correctly renders pre-upgrade sessions" cannot yet be
claimed true: the existing test covers structural linkage (`id`/`parentId`) but not
the v2→v3 role rename, not the real production load path, and not that rendered
content survives migration unchanged.

**P5 — The release pipeline cannot detect a macOS-only regression.** A change that
builds fine on Ubuntu (the only platform `release.yml` exercises) but breaks
installation or execution on macOS would ship undetected, despite macOS being fully
supported per ADR 0005.

**P6 — The front door states last year's status.** `README.md` is the first thing a
stranger reads. It says Phase 0. That is a credibility problem independent of
anything else in this phase.

## Goals

- [ ] `reportInstallTelemetry()` and its `pi.dev` network call are removed; no code
      path in the tree sends any network request to a domain Apex Code does not
      operate as an update/version ping.
- [ ] The update-available check (`version-check.ts`) queries the real, already-used
      npm registry for `apex-code`'s own `next` dist-tag (matching the README's
      documented install channel) instead of `pi.dev`'s Pi-version endpoint; the
      resulting notification's changelog link points at Apex Code's own
      `CHANGELOG.md` (via its GitHub blob URL — no new hosted page required), not
      Pi's. Every `Pi`-branded identifier in this module (`LatestPiRelease`,
      `checkForNewPiVersion`, `getLatestPiVersion`, `getLatestPiRelease`) is renamed
      to match.
- [ ] `enableAnalytics` and `trackingId` are removed from `Settings`,
      `SettingsManager`, and the settings-selector UI — dead code, not a feature
      being cut. The first-time-setup onboarding dialog's second step, which asked
      every new user to consent to this non-functional analytics and referenced a
      nonexistent `/privacy` command under Pi's own name, is removed too — onboarding
      becomes theme-selection only.
- [ ] Provider-attribution headers (`provider-attribution.ts`) are retained (real,
      defensible mechanism serving the user's own provider relationship) but
      rebranded from `"pi"`/`"Pi"` to Apex Code's own identity, and gated by a new,
      honestly-named `sendProviderAttribution` setting (default `true`) rather than
      the deleted install-telemetry one. **Correction found during implementation:**
      the spec originally called for making these headers unconditional once
      un-gated. `test/sdk-openrouter-attribution.test.ts` (16 existing tests, missed
      in the initial `grep` for `provider-attribution` by filename) proves a user can
      currently opt these headers out entirely via `enableInstallTelemetry: false`.
      Making them unconditional would silently remove that choice for anyone who
      already made it — a real regression, not a cleanup. A dedicated setting
      preserves the choice under its correct name instead of conflating it with the
      (now-deleted) telemetry concept it was never really about.
- [ ] `SECURITY.md` accurately reflects current code: the "pre-alpha... security
      posture is not hardened until Phase 9" framing is corrected once this phase's
      hardening is verifiable, without overclaiming guarantees this phase does not
      provide.
- [ ] A generated, consolidated third-party dependency license report exists,
      produced by a script runnable both locally and from CI/release, fulfilling
      `NOTICE`'s existing promise.
- [ ] A test drives each of `migrateV1ToV2` and `migrateV2ToV3` — and the v1→v3
      chain — against real fixture session files, asserting both that migration
      succeeds and that the migrated session renders the same entries (messages,
      tool calls, usage) as the pre-migration source.
- [ ] `release.yml` verifies a clean `npm install --global` and version check on
      macOS in addition to Ubuntu.
- [ ] `README.md` states the real current phase status and links to a real user
      installation/usage guide (not only the phase-tracking docs under `docs/`).
- [ ] A short user-facing guide exists covering install, first run, and where to go
      next (permissions, sandbox, providers) — the "user documentation, not just
      docs/" the roadmap names, scoped to what a pre-alpha adopter actually needs,
      not a full manual.

## Flagged, deliberately not touched

Found while tracing every `pi.dev` reference for this spec; both are genuinely
different in kind from P1/P1a and are not resolved here.

- **`remote-catalog-provider.ts`'s `DEFAULT_CATALOG_BASE_URL = "https://pi.dev"`**
  fetches live model pricing/capability data, not app telemetry. This may be a
  deliberate reliance on upstream Pi's maintained catalog feed (consistent with
  ADR 0001's "35 providers keep updating for free"), or it may be the same
  never-repointed-after-fork issue as P1/P1a wearing different clothes. No ADR or
  spec documents an intentional decision either way. Resolving it requires deciding
  whether Apex Code should depend on Pi's live infrastructure for functional data at
  runtime — an architectural question, not a telemetry cleanup.
- **`config.ts`'s `DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/"`**, used by
  `/share` (session-to-gist sharing) to render a shared session nicely. Same
  reasoning: a real hosted-viewer dependency Apex Code has no equivalent of, not a
  telemetry bug.

Both are recorded here so they are not lost, not silently expanded into this spec's
scope.

## Non-goals

- [ ] **Building new Apex-directed telemetry infrastructure.** No new endpoint, no
      new ping, no new opt-in mechanism. Removing the broken one and the dead one
      makes the roadmap's "opt-in-only telemetry, published list of what is
      collected" trivially and honestly true: nothing is collected, and that fact is
      documented. Building a working replacement is a future decision requiring its
      own privacy-policy discussion, not something this session decides unilaterally.
- [ ] **Windows support.** Standing exclusion per ADR 0005, not reopened here.
- [ ] **Cutting a graduating, non-pre-alpha release.** Explicit user decision this
      session: infrastructure only. The project's README continues to say pre-alpha;
      this phase does not change that framing, only corrects its stated phase number.
- [ ] **A session-format version bump.** `CURRENT_SESSION_VERSION` stays at 3. No
      Apex Code phase so far changed the session entry schema in a way requiring a
      new migration; this phase tests the existing v1→v2→v3 path, it does not add a
      v3→v4 one.
- [ ] **A full user manual.** The user guide this phase adds is scoped to
      install/first-run/where-next. Comprehensive reference documentation for every
      setting, tool, and permission rule is a larger, separate undertaking.
- [ ] **"Monitored" as a provable code artifact.** `SECURITY.md`'s disclosure path
      already exists (GitHub private vulnerability reporting). Whether reports are
      actually watched is an operational commitment, not something a test can assert;
      this spec verifies the *path* is accurate and current, not that a human is
      staffing it.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Install-ping removal | Delete `reportInstallTelemetry()` and its call site; delete `isInstallTelemetryEnabled` if no longer referenced after provider-attribution is un-gated from it | `src/modes/interactive/interactive-mode.ts`, `src/core/telemetry.ts` |
| Dead-setting removal | Remove `enableAnalytics`, `trackingId` from `Settings`, their getters/setters, and the settings-selector menu entry | `src/core/settings-manager.ts`, `src/modes/interactive/components/settings-selector.ts` |
| Attribution rebrand | Replace hardcoded `"pi"`/`"Pi"`/`pi.dev` strings in `provider-attribution.ts` and `utils/pi-user-agent.ts` with Apex Code identity; keep sending to the user's own configured provider only | `src/core/provider-attribution.ts`, `src/utils/pi-user-agent.ts` |
| License report | New script generating a consolidated third-party license report from `package.json`/lockfile data across workspaces; callable via `npm run` and from `release.yml` | `scripts/apex/generate-license-report.mjs` (new) |
| Migration test coverage | Fixture-driven tests for `migrateV1ToV2`, `migrateV2ToV3`, and the full v1→v3 chain, asserting entry-for-entry equivalence post-migration | `packages/coding-agent/test/session-manager/format-migration.test.ts` (new) |
| Cross-platform release verification | Add a macOS job to `release.yml`'s publish-verification step (or a parallel job depending on the same published version) | `.github/workflows/release.yml` |
| Docs | Correct `README.md`'s phase status; add a short install/first-run guide; update `SECURITY.md`'s pre-alpha framing to match verified state | `README.md`, `docs/user-guide.md` (new), `SECURITY.md` |

No load-bearing seam named in `docs/architecture/overview.md` (`beforeToolCall`,
`ruleContent`, `transformContext`, evidence capture) is touched by this phase.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `reportInstallTelemetry()` and its call site | code | Removed. Sent data to a domain Apex Code doesn't operate, under the wrong product's identity — not a working feature being cut, a bug being fixed. |
| `src/core/telemetry.ts` (`isInstallTelemetryEnabled`) | code | Removed — zero remaining consumers once `provider-attribution.ts` reads the new `sendProviderAttribution` setting directly. |
| `enableAnalytics`, `trackingId` settings and their storage | code, config | Removed. Zero production consumers ever existed. |
| `first-time-setup.ts`'s analytics onboarding step | code | Removed. Not dead-and-harmless: it actively asked every new user to consent to analytics sharing that never happened, and referenced a nonexistent `/privacy` command under Pi's name. Onboarding is theme-selection only now. |
| `src/utils/pi-user-agent.ts` | code | Renamed to `apex-code-user-agent.ts` (`getPiUserAgent` → `getApexCodeUserAgent`), not just edited in place — the old name was itself part of the branding bug. |
| `LatestPiRelease`, `getLatestPiRelease`, `getLatestPiVersion`, `checkForNewPiVersion` (`version-check.ts`) | code | Renamed to their Apex Code equivalents; `LATEST_VERSION_URL` repointed from `pi.dev`'s custom API to the npm registry's `next`-tag endpoint for this package. |
| `PI_TELEMETRY` env var and its `--help` line | code, doc | Removed — its only consumer (`isInstallTelemetryEnabled`) is gone. `PI_OFFLINE`/`PI_SKIP_VERSION_CHECK` are unchanged; renaming established env var names is a separate compatibility question this spec does not open. |
| `SECURITY.md`'s "security posture is not hardened until Phase 9" caveat | doc | Superseded by accurate, current-state language once this phase's hardening is verified — not deleted, corrected (task 9.6). |

## Regression found and fixed during closure verification (9.6)

The full test suite caught a real regression from 9.1's `version-check.ts` rewrite:
`test/package-command-paths.test.ts`'s two "renamed package" self-update tests
mocked the version-check response with a `packageName` field — the old custom
API's shape — but `getLatestApexCodeRelease` reads npm's real per-tag registry
field, `name`. The mocks silently stopped matching, so the tests exercised (and
passed) the *wrong* code path (ordinary upgrade, not rename-detection) without
ever failing loudly until the real assertions on recorded npm CLI arguments
caught it.

This was not a capability loss: `getSelfUpdatePlan`'s rename-detection logic in
`package-manager-cli.ts` was never touched and still works — the test mocks were
speaking the old API's vocabulary. Fixed by updating both mocks to `name`,
matching what the real npm registry actually returns and what the new
implementation actually reads. All 27 tests in that file pass, including both
previously-broken ones, now genuinely exercising the rename path end to end
rather than accidentally exercising the fallback path.

## Risks

**Removing a setting a user has already toggled.** A user who set
`enableInstallTelemetry: false` or `enableAnalytics: true` in their config has that
key silently ignored after removal, since one gates removed code and the other never
did anything. Mitigation: neither removal changes observable behavior for any user in
either state (no working call existed to opt out of in the second case; the first
case's opt-out is honored by the call no longer existing at all). Signal this is
wrong: any test or user report showing installed extensions or CLI flags fail to
parse due to the removed keys, which `settings-manager.ts`'s general "unknown keys
are ignored" merge behavior should already prevent — verified, not assumed, as part
of the removal's test.

**License report going stale.** A generated-once report drifts from `package.json` as
dependencies change. Mitigation: generate it in CI/release, not commit a static copy
as the source of truth — the release pipeline is what keeps it current.

**Platform-specific release verification doubles publish-step risk surface.** Two
platforms verifying against one published version has more that can flake (registry
propagation timing, per-platform install quirks). Mitigation: the existing Ubuntu
job's retry-with-fresh-cache pattern (already handles registry propagation lag) is
reused for macOS, not reinvented.

## Verification

| Goal | How |
| --- | --- |
| No network call to a domain Apex Code doesn't operate | Test: full grep-based assertion that no `fetch`/network call target string outside allowlisted provider/registry domains exists in `src/`, plus the specific removal verified by absence of `reportInstallTelemetry` in the tree |
| Dead settings removed | Typecheck clean after removal (no dangling references); settings-selector no longer renders the removed entries |
| Attribution headers still work, now correctly branded | Existing `provider-attribution` tests updated and passing with the new identity strings |
| License report exists and runs | `npm run generate:license-report` (or equivalent) produces a non-empty report covering all workspace dependencies, exercised in a test or CI step |
| Migration preserves session content | New fixture tests: v1→v2, v2→v3, and v1→v3 chained, each asserting the migrated entries render identically (message content, tool calls, usage) to hand-verified expected output |
| Cross-platform install works | `release.yml`'s macOS job passes on the next real tagged release (verified at that release, not fabricated here) |
| README accurate | Manual read-through against `docs/roadmap.md`'s actual phase table |

Standard gates: `npx tsgo --noEmit`, `npm run build`, `npx biome check`, and a full
`npm test` run characterized against the pre-existing failure set the same way every
prior phase in this roadmap has been.

## Rollout

Needs `docs/plans/2026-08-16-release-hardening.md` — six independent-ish task slices
(telemetry removal, license report, migration tests, release workflow, docs) with
their own status tracking, though most have no ordering dependency on each other and
may land in any order or in parallel.

No ADR needed: the telemetry removal is corrective (fixing verified-wrong behavior),
not a new irreversible architectural commitment, and is fully explained by this spec
plus the `enableInstallTelemetry ?? true` finding already on record in ADR 0012's
"Inherited state this ADR does not resolve" section, which this phase now resolves.
