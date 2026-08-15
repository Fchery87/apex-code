# Phase 8 observability & cost

**Status:** Not started — 0 of 7 tasks

This plan implements `docs/specs/2026-08-15-observability-and-cost.md` and ADR
`0012-observability-export-boundary.md`. Task 8.1 is the blocking prerequisite: the
per-request sample store built in Phase 1 is constructed only in tests, so
`instrumentAttempt` short-circuits in every real session and the Phase 6 tables have
never held a row. Until 8.1 lands, every gate in this phase measures an empty table
and would pass vacuously — the same failure mode Phase 3's replay gate hit when
`replay()` never installed the context pipeline.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 8.1 Production wiring, ledger schema, and retention | Not started | — | Failing-first test through the **production** path (`createAgentSessionServices`, not a test-constructed store) asserting one durable row per request attempt with provider/model/role/outcome/ttft/generation/tokens/cost; a forced credential rotation records its own row so attempts exceed turns; version-3 fixture database migrates to 4 with `command_journal`/`session_leases`/`cache_entries` intact; `usage_totals` dropped; an unwritable database degrades to a diagnostic with the turn still completing |
| 8.2 Cross-projection reconciliation gate | Not started | — | The ledger's per-session cost aggregate equals `getUsageCostBreakdown()` over the same session's entries **exactly**, over a recorded session containing assistant messages, tool results, and at least one compaction or branch summary; this is the phase's correctness anchor and the answer to ADR 0010's principle applied outside the tool registry |
| 8.3 Aggregation module and `apex-code cost` | Not started | — | One query module grouping cost and latency by model, session, and role over a caller-specified range; `apex-code cost --since` exercised end to end against a seeded ledger; per-role rows are non-empty when roles were used, which is the dimension nothing surfaces today |
| 8.4 `/session` role and latency | Not started | — | `/session` additionally renders per-role attribution and ttft/generation; existing per-model breakdown and cache-waste output unchanged (assert the existing lines still render, so this is additive and not a rewrite) |
| 8.5 OTLP trace export | Not started | — | Zero outbound requests attributable to observability across a full turn when unconfigured (`fetch` spy); with an endpoint set, a captured POST body is well-formed OTLP/HTTP JSON whose attribute keys are a **subset of the ADR 0012 allowlist**, asserted positively rather than by absence of known-bad keys; export uses global `fetch` so a set `HTTP_PROXY` is honoured |
| 8.6 Footer accessibility and display settings | Not started | — | With SGR sequences stripped, the 70% and 90% context thresholds differ from nominal in the remaining text — the color-only WCAG 1.4.1 failure at `footer.ts:154-160` is gone at **default** settings, not behind an opt-in; `symbolPreset: "ascii"` renders no codepoint above U+007F; `tokenUsageDisplay` honours `off`/`compact`/`full`; `colorBlindMode` adjusts palette only |
| 8.7 Phase verification and closure | Not started | — | Full `npm test`, failures characterised individually against the known pre-existing set rather than reported green; typecheck, build, and biome clean; roadmap Phase 8 row closed with the real SHA; this plan deleted per the lifecycle convention |

## Order changes

None yet. 8.1 is first because nothing in this phase is measurable before it — a gate
run against an empty ledger passes for the wrong reason. 8.2 follows immediately
rather than last, because it is the test that decides whether the ledger is *correct*
rather than merely populated; discovering a cost-attribution bug in 8.7 would
invalidate 8.3 and 8.4's output.

**8.6 is genuinely independent** of the ledger — it touches only `footer.ts` and
`settings-manager.ts`. It is sequenced sixth for narrative coherence, not dependency,
and may be pulled forward freely (including in parallel) without disturbing the rest.
If it is moved, correct the order here rather than annotating it.

## Task 8.1 — production wiring, ledger schema, and retention

### Red

1. Add the public-boundary test that builds services through
   `createAgentSessionServices` with a scratch agent directory and a scripted provider,
   drives one turn, and asserts exactly one ledger row carrying every sample field.
   It must fail first for the right reason — no rows at all, because no store is
   constructed — not because the table is missing.
2. Add the rotation test: force a retryable failure on the primary credential and
   assert two rows (the rotated-away attempt and the successful one), proving the
   ledger counts *attempts* rather than turns.
3. Add the migration test against a fixture database written at schema version 3 with
   rows in `command_journal`, `session_leases`, and `cache_entries`; assert version 4,
   all rows intact, `usage_totals` gone.
4. Add the degradation test: make the database unwritable and assert the turn still
   completes and surfaces a diagnostic. Observability must never fail a turn.

### Green

- Extend `model_performance` in a `version < 4` migration branch with `session_id`,
  `role`, `credential_identity`, `outcome`, `failure_kind`, the four token columns, and
  `cost`; drop `usage_totals` in the same branch. Bump
  `CURRENT_DURABLE_STATE_SCHEMA_VERSION` to 4.
- Implement `SqliteUsagePerformanceStore` against the existing `UsagePerformanceStore`
  interface. Construct it **per session** so it stamps `session_id` on write:
  `UsagePerformanceSample` has no session field and `ModelRuntime` is session-agnostic,
  so attribution cannot come from `instrumentAttempt` and must not be threaded through
  it.
- Wire it at `agent-session-services.ts` where the runtime is created. Do not wire the
  standalone runtimes (`auth-check.ts`, `credential-print.ts`, `package-manager-cli.ts`)
  — they are not sessions and have nothing to attribute.
- Prune rows older than `observability.retentionDays` (default 90) on store open.
- Delete `FileUsagePerformanceStore` and its tests. It was never constructed outside
  tests, so nothing depends on it.

### Refactor

Keep the store a plain sink behind the existing interface — no aggregation, no
formatting, no export concerns. 8.3 owns querying and 8.5 owns egress; a store that
also knows how to group or emit is the shape that makes both untestable.

## Shared implementation rules

- Write the failing test before each slice and run the narrowest file first.
- **Self-measurement discipline is non-negotiable this phase.** Every test that drives
  a turn uses `mkdtemp`/`chdir` to a scratch directory. There are now two ledgers a
  careless test can pollute — Phase 7's evidence store and this phase's cost ledger —
  and the symptom of getting it wrong (`apex-code cost` reporting real spend on a
  machine that has only run the suite) is quiet.
- No new runtime dependency. The exporter uses global `fetch`, already bound to a
  proxy-aware dispatcher by `http-dispatcher.ts`; importing undici directly would
  bypass a user's `HTTP_PROXY`, which is a defect in precisely the component that must
  be most conservative about egress.
- Span attributes are added to the ADR 0012 allowlist explicitly or not at all.
  Extending `UsagePerformanceSample` must not silently widen what is exported.
- Nothing in this phase sends data to the project. `enableInstallTelemetry`'s
  inherited default-on behaviour is recorded in the spec and ADR 0012 as Phase 9's
  problem and is not touched here.
- Cost and latency are *reported*, never *acted on*. Measured routing is an explicit
  non-goal; `model_performance` becoming trustworthy is this phase's contribution to
  it, and consuming it is a later decision.

## Measurement record to complete in 8.7

| Measurement | Result |
| --- | --- |
| Ledger rows per turn, single-attempt baseline | — |
| Ledger rows per turn under forced rotation | — |
| Ledger vs. `getUsageCostBreakdown` per-session delta | — (must be exactly 0) |
| Durable-state size growth per 1,000 request attempts | — |
| Outbound requests attributable to observability, unconfigured | — (must be 0) |
| Static prefix tokens, before vs. after | — (must be unchanged; this phase registers no tool) |

The last row is a regression guard, not a goal: Phase 4 fixed the enforced prefix
budget at 2,150 against a 2,300 ceiling, and Phase 8 adds no tool, so any movement
means something unintended entered the system prompt.

## Post-landing obligation

Recorded cost within 5% of a real provider invoice, via `apex-code cost --since`
against a real statement over a one-week window. This is **not** a phase gate — see
the roadmap's amended Phase 8 criterion — but it is owed, and it is discharged by a
further roadmap amendment recording the measured delta, never by ticking a box.
