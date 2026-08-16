# Phase 8 observability & cost

**Status:** In progress — 1 of 7 tasks done (8.1)

This plan implements `docs/specs/2026-08-15-observability-and-cost.md` and ADR
`0012-observability-export-boundary.md`. Task 8.1 is the blocking prerequisite: the
per-request sample store built in Phase 1 is constructed only in tests, so
`instrumentAttempt` short-circuits in every real session and the Phase 6 tables have
never held a row. Until 8.1 lands, every gate in this phase measures an empty table
and would pass vacuously — the same failure mode Phase 3's replay gate hit when
`replay()` never installed the context pipeline.

**8.1 is larger than "wire an existing table."** Verified: `openDurableStateStore`
is called only by `DurableStateDaemon`, and nothing outside `DurableStateDaemon`'s
own test constructs that class. No CLI command opens a durable-state database today
— the whole SQLite subsystem is untested against production use, not just its two
dead tables. `SqliteUsagePerformanceStore` becomes the first production caller of
`openDurableStateStore`, opening the database directly and independent of the
daemon (which stays out of scope). This means 8.1 must prove concurrent-open safety
itself; no prior phase did.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 8.1 Production wiring, ledger schema, and retention | Done | `bc11de73c` (core slice) + follow-up commit (retention/degradation/concurrent-open) | **Verified test-first, `test/observability/usage-ledger.test.ts` (6 tests) + updated `test/usage-performance-store.test.ts` + `test/durable-state/sqlite-store.test.ts`:** a failing-first test through the real production path (`createAgentSessionServices`, no store passed explicitly) proves a durable, session-attributed row is recorded per request attempt (provider/model/session/role/outcome/ttft/generation/tokens/cost), constructed and consumed as `SqliteUsagePerformanceStore`; store-level test proves one row per credential-pool attempt including a rotated-away failure; a hand-built version-3 fixture migrates to version 4 with `command_journal`/`session_leases`/`cache_entries` untouched, `model_performance` carrying all ten new columns, and `usage_totals` dropped; retention pruning removes a 200-day-old row on store open while a recent one survives; a directory-shaped database path (a portable, non-permission-dependent failure trigger) degrades to an `AgentSessionRuntimeDiagnostic` warning rather than throwing, and the turn still completes; two `SqliteUsagePerformanceStore` instances opened concurrently against one path each record two interleaved samples with no corruption or exception — `node:sqlite`'s own locking held under real concurrent access, not merely assumed. `FileUsagePerformanceStore` deleted (zero remaining references). Typecheck and biome clean. **Full-suite verification:** `npm test` from `packages/coding-agent` — 4 failed files / 6 failed tests / 269 passed / 6 skipped (279 files; 2323 passed / 53 skipped of 2382 tests). Re-running the 4 failing files in isolation (no full-suite CPU contention) reproduced only `external-editor`'s 3 failures — the pre-existing one already characterized in this roadmap's Phase 2b closure — while `session-id-readonly`, `startup-session-name`, and `session-manager/file-operations` all passed cleanly alone; none of the three references any file this task touched, confirming CPU-contention timeouts under full parallel load, not regressions. A `--no-file-parallelism` full-suite rerun (the stronger confirmation prior phases used) was not additionally performed. |
| 8.2 Cross-projection reconciliation gate | Done | uncommitted | **Verified, `test/observability/reconciliation.test.ts`:** a session with two assistant messages, a tool-result usage entry, and a compaction entry sums to exactly the same total (0.2) via `getUsageCostBreakdown()` and via the new `aggregateUsagePerformance()` query module over matching ledger rows; a second test proves two sessions' ledger rows never cross-contaminate an aggregate. **A real finding, verified by reading (not assumed) before writing this test:** production assistant turns *and* compaction/branch-summary calls both route through the same `modelRuntime.streamSimple`-backed `streamFn` — `sdk.ts`'s `Agent` construction wires `streamFn` directly to `modelRuntime.streamSimple`, and `context/pipeline.ts`'s `installContextPipeline` always *wraps* the previous `streamFunction` (`previousStreamFunction(...)` is called in every branch) rather than replacing it — so compaction's `streamFn: this.agent.streamFunction` (`agent-session.ts:3142`) is the same instrumented path. This directly contradicts an earlier draft assumption (never committed) that compaction bypassed the ledger via a raw `pi-ai` `streamSimple`; that assumption was based on reading `test-harness.ts`'s simplified test-only `Agent` construction, not production's `sdk.ts`. Test-level implication: the test constructs entries and ledger rows independently (matching this repo's own established pattern in `agent-session-stats.test.ts` for this class of aggregation test) rather than driving a live multi-turn session through real compaction, since triggering token-threshold compaction live is a separate, heavier integration concern the reconciliation gate doesn't need to re-prove. |
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
5. Add the concurrent-open test: two `SqliteUsagePerformanceStore` instances against
   the same path (simulating two CLI invocations against one agent directory) each
   record a sample from a concurrent turn; assert both rows land and neither instance
   throws. This is the first production exercise of `openDurableStateStore` under
   concurrency, so it is proven here rather than assumed from `DurableStateDaemon`'s
   isolated tests.

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
