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
| That migration has **zero test coverage** | `grep -rl "migrateV1ToV2\|migrateV2ToV3" test/` returns nothing. The exit criterion "an upgrade... preserves and correctly renders pre-upgrade sessions" is currently unverified, not merely unautomated. |
| The release pipeline verifies install on Ubuntu only | `.github/workflows/release.yml`: single job, `runs-on: ubuntu-latest`. It publishes both packages, then does a real clean-registry `npm install --global` and version check — but only on one of the two supported platforms. |
| README is stale | `README.md:5`: "Status: pre-alpha, Phase 0." Phases 0–8 are landed. The document a stranger reads first states a phase eight behind reality. |
| `enableInstallTelemetry` (default `true`) gates a real network call, and that call is a verified bug independent of its opt-in status | `interactive-mode.ts:1198-1215`, `reportInstallTelemetry()`: fires once per detected version upgrade (not every startup), `GET https://pi.dev/api/report-install?version=<VERSION>`, `User-Agent: pi/<VERSION> (<platform>; <runtime>; <arch>)` (`utils/pi-user-agent.ts:1-4`, hardcoded `"pi/"` prefix). `VERSION` is Apex Code's own `package.json` version (`config.ts:492`). Unmodified upstream Pi code: the endpoint, and the User-Agent brand string, were never updated for the fork. Today, every Apex Code upgrade reports itself to Pi's telemetry as a Pi install, under Apex Code's real version number — wrong regardless of consent, since it's data sent to a domain Apex Code doesn't own and provides Apex Code no value. |
| The same setting also gates provider-attribution HTTP headers, a materially different and more defensible mechanism | `provider-attribution.ts:36-65`: `HTTP-Referer`, `X-OpenRouter-Title`, `X-BILLING-INVOKE-ORIGIN`, User-Agent headers attached to requests already going to the user's own configured LLM provider (OpenRouter/NVIDIA NIM/Cloudflare), for that provider's own billing-origin attribution — never sent to a third party. Also still hardcoded `"pi"`/`"Pi"`. |
| `enableAnalytics`/`trackingId` ("opt-in analytics") is dead code | `getEnableAnalytics()` (`settings-manager.ts:1002`) has zero production consumers anywhere in the tree — only its own getter/setter and `test/first-time-setup.test.ts`, which asserts the *stored preference*, never that anything is sent. Enabling this setting today changes no behavior. |
| No mechanism sends data to the Apex Code project today | Following from the two rows above: there is currently no working or broken Apex-directed telemetry of any kind — only a misdirected Pi ping and an inert dead switch. |

## The problem

**P1 — A verified misattribution bug, unconditional on any settings.** Every Apex
Code install that detects a version upgrade reports itself to Pi's telemetry
endpoint as a Pi install. This is not a privacy question first; it is a correctness
bug: the data is wrong (claims to be software it is not) and sent to a party with no
relationship to it (Apex Code does not operate `pi.dev`).

**P2 — A dead setting invites false confidence.** A user who enables "opt-in
analytics" in good faith, expecting it to do something, is enabling nothing. The
setting's existence implies a capability that was never built.

**P3 — `NOTICE` makes a promise the repo does not keep.** It states a consolidated
license report is "generated as part of the release process." No script, no CI step,
and no such report exists anywhere in the tree.

**P4 — The migration path this phase's own exit criterion names is unverified.**
"Preserves and correctly renders pre-upgrade sessions" cannot be claimed true; it has
never been tested.

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
- [ ] `enableAnalytics` and `trackingId` are removed from `Settings`,
      `SettingsManager`, and the settings-selector UI — dead code, not a feature
      being cut.
- [ ] Provider-attribution headers (`provider-attribution.ts`) are retained (real,
      defensible mechanism serving the user's own provider relationship) but
      rebranded from `"pi"`/`"Pi"` to Apex Code's own identity, and no longer gated
      by the now-removed install-telemetry setting.
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
| `isInstallTelemetryEnabled()` / `src/core/telemetry.ts` | code | Removed if, after the attribution un-gating above, nothing references it; otherwise retained solely for the (now Apex-branded, ungated-by-this-setting) attribution headers — resolved during implementation, recorded here either way. |
| `enableAnalytics`, `trackingId` settings and their UI entry | code, config | Removed. Zero production consumers ever existed; a settings key with no behavior is misleading, not a minimal feature. |
| `SECURITY.md`'s "security posture is not hardened until Phase 9" caveat | doc | Superseded by accurate, current-state language once this phase's hardening is verified — not deleted, corrected. |

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
