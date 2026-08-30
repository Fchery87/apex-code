# Spec: Observability & cost

**Status:** Landed


## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Created | 2026-08-15 |
| Last updated | 2026-08-15 |
| Roadmap phase | `8 — Observability & cost` |
| Tracking issue/PR | none |
| Compatibility posture | **Preserves compatibility**, with one deliberate default-visible change — see below |

**Compatibility posture.** Every change here is additive at the interfaces users
depend on. The durable-state schema moves 3 → 4 through the existing migration
ladder: new columns are additive, and the one table dropped (`usage_totals`) has
never had a production writer, so it is empty in every database that has one — the
drop cannot lose data, and that claim is verifiable rather than asserted (see
*Current state*). New settings default to today's behavior. The session format
(`ADR 0006`) is untouched. `apex-code cost` is a new subcommand and displaces
nothing.

The one deliberate exception: the footer stops encoding context pressure in colour
alone, so **every** user sees a new non-colour marker at the 70% and 90%
thresholds, not just those who opt in. That is intentional. Gating an accessibility
fix behind a setting leaves the defect on by default for exactly the users who
cannot see it, which is not a fix. `colorBlindMode` then further adjusts the
palette; it is not what makes the state legible.

## Executive summary

Phase 8 is mostly **not** new capability. Phases 1 and 6 each built half of this
phase's foundation and left both halves unwired: the per-request sample store is
constructed only in tests, and the two SQLite tables meant to hold its output have
no reader and no writer anywhere in the repository. This phase makes that
already-designed instrumentation actually run, gives it a durable cross-session
home, and adds the two dimensions nothing currently surfaces — **per-role
attribution** and **latency**. It then ships a headless `apex-code cost`
reconciliation command, an off-by-default OTLP/HTTP trace export with no new
dependencies, and fixes a WCAG 1.4.1 colour-only failure in the footer. Phase 8's
roadmap exit criterion is amended on the record, before implementation, because as
written it cannot be checked by anyone without a paid provider account and a week
of wall-clock time.

## Context and motivation

- `docs/roadmap.md` § Phase 8 — the phase this serves, and the exit criterion this
  spec amends. Also § Ground rules 3 ("every phase exits on a number"), which is
  the rule the current criterion violates.
- `docs/specs/2026-08-10-provider-and-model-layer.md` — Phase 1 introduced
  `UsagePerformanceSample`/`UsagePerformanceStore` and the `model_perf` concept.
  The sample type it defined is sufficient for this phase; the gap is purely that
  nothing in production constructs a store.
- `docs/specs/2026-08-15-durable-state-and-daemon.md` and `docs/adr/0006` — Phase 6
  built the SQLite durable-state store and declared `usage_totals` and
  `model_performance` in its schema, without wiring either.
- `docs/adr/0010-one-canonical-tool-contract.md` — the "one projection, never
  re-derived" principle. This phase creates a second cost computation alongside an
  existing one, so it must answer to that principle explicitly (see *Risks*).
- `docs/adr/0007-evidence-capture-and-policy-boundary.md` — Phase 7's
  capture-at-the-source precedent, and the `inScratchRepo` self-measurement
  discipline this phase inherits.
- `docs/research/2026-08-08-harness-comparative-review.md` § 174 — the ASCII symbol
  preset and colourblind mode originate here. Per ADR 0002 this research doc is the
  only permitted channel for those observations.

## Current state

Verified against the tree at `035606611`, not recalled.

| Fact | Evidence |
| --- | --- |
| No production code constructs a sample store | `new FileUsagePerformanceStore` and `new InMemoryUsagePerformanceStore` appear only under `packages/coding-agent/test/`. Zero occurrences in `src/`. |
| No production `ModelRuntime` receives one | The main session path, `src/core/agent-session-services.ts:144`, passes `authPath`/`modelsPath`/`signal` only. Same for `src/main.ts:172`, `src/core/sdk.ts:215`, `src/cli/auth-check.ts:67`, `src/package-manager-cli.ts:401`. `options.usagePerformanceStore` reaches the constructor as `undefined` at `src/core/model-runtime.ts:241`. |
| Capture is therefore a no-op, not merely unread | `instrumentAttempt` opens `if (!store) return stream;` (`src/core/model-runtime.ts:735`). In production the instrumentation wrapper is bypassed entirely — no sample is built and discarded; none is built at all. |
| `usage_totals` and `model_performance` are dead schema | Declared at `src/core/durable-state/sqlite.ts:109` and `:117`. No `INSERT`, `UPDATE`, or `SELECT` against either name exists anywhere in `packages/`. The `TABLES` const (`sqlite.ts:35`) is used at exactly one site, `sqlite.ts:255`, as a read-only allowlist for a `columns()` introspection helper. The store exposes no generic write path. |
| `model_performance` cannot hold the sample as typed | It has `provider`, `model_id`, `ttft_ms`, `generation_ms`, `sampled_at`. `UsagePerformanceSample` (`src/core/usage-performance-store.ts:14-28`) additionally carries `role`, `credentialIdentity`, `outcome`, `failureKind`, four token counts, and `cost`. |
| Neither the sample nor `ModelRuntime` knows the session | `UsagePerformanceSample` has no session field, and `ModelRuntime` is session-agnostic — it is constructed per session at `agent-session-services.ts:144` but may also be created standalone (`sdk.ts:215`, `auth-check.ts:67`) and accepted pre-built via `options.modelRuntime`. Session attribution cannot come from `instrumentAttempt`. |
| **The whole SQLite durable-state subsystem has zero production callers, not just its two dead tables** | `openDurableStateStore` (`sqlite.ts:196`) is called only by `DurableStateDaemon` (`daemon.ts:33`), and `DurableStateDaemon` is constructed only in its own test file (`test/durable-state/daemon.test.ts`) — zero matches for `new DurableStateDaemon(` or any daemon-starting call in `src/`. No CLI command opens a durable-state database today. This phase's sample store is therefore the **first production caller** of this subsystem, not a second table added to a running one. |
| The file-backed store is quadratic | `FileUsagePerformanceStore.record()` (`src/core/usage-performance-store.ts:85-91`) parses the entire JSON document and rewrites it pretty-printed under lock, once per request attempt. Its own header comment (`:77`) says "Transitional: Phase 6 supersedes this with SQLite." Phase 6 landed and did not. |
| Durable-state schema is at version 3 | `CURRENT_DURABLE_STATE_SCHEMA_VERSION = 3` (`sqlite.ts:5`). Migrations are an `if (version < N)` ladder with `ALTER TABLE` (`sqlite.ts:201-240`). |
| Per-model, per-session cost **already ships** | `/session` (`src/modes/interactive/interactive-mode.ts:5992`) renders token totals with a cached/uncached split and hit rate, total cost, a per-`provider/model` cost breakdown via `getUsageCostBreakdown` (`src/core/usage-totals.ts:37`), and cache re-billed waste via `computeCacheWaste` (`src/core/cache-stats.ts:138`). |
| Role and latency surface nowhere | `getUsageCostBreakdown` groups by `provider/model` only. `SessionStats` (`src/core/agent-session.ts:285-302`) has no latency field of any kind. |
| Nothing is cross-session | `/session` computes from the current session's in-memory entries. No durable store answers "what did this cost this week". |
| Context pressure is signalled by colour alone | `src/modes/interactive/components/footer.ts:154-160` selects `theme.fg("error")`, `theme.fg("warning")`, or plain for identical display text. |
| The footer uses unguarded non-ASCII glyphs | `↑ ↓` at `footer.ts:130-133`, `•` at `:125` and `:163`. No ASCII fallback exists. |
| `symbolPreset` / `colorBlindMode` do not exist in code | They appear only in `docs/roadmap.md:582` and `docs/research/2026-08-08-harness-comparative-review.md:174`. |
| HTTP already has a single configured egress path | `src/core/http-dispatcher.ts` installs a **global** undici dispatcher and global `fetch` built on `EnvHttpProxyAgent`, with proxy and idle-timeout handling. |
| A default-on phone-home is inherited from upstream | `settings-manager.ts:974` returns `enableInstallTelemetry ?? true` — an anonymous version/update ping, live at `interactive-mode.ts:4399`. `enableAnalytics` correctly defaults to `false` (`:984`). |

Everything above except the last two rows is Apex Code's own state. The HTTP
dispatcher and the install-telemetry default are inherited upstream Pi behaviour;
changing the latter carries an upstream-divergence cost under ADR 0003 and is
**not** in this phase (see *Non-goals*).

## The problem

**P1 — The instrumentation does not run.** Every per-request latency and cost
sample this phase would report is never recorded in any real session. This is not a
gap in reporting; it is a gap in capture. It is structurally the same defect Phase 3
left behind for Phase 4 (`loadDeferredSchema` announced but with no production
caller), and it has the same consequence: every downstream gate measures an empty
table until it is fixed. Nothing else in this phase can be verified before it lands.

**P2 — The intended home is dead schema.** `usage_totals` and `model_performance`
exist in every user's database and have never held a row. Meanwhile the only working
implementation rewrites its entire history pretty-printed on every request attempt,
which is O(n²) in bytes written over a session and unbounded in growth. For the
phase whose criterion is stated over *a one-week real-usage window*, the available
store disqualifies itself.

**P3 — Two of the three promised dimensions are missing, and one is already done.**
The roadmap asks for "per-model, per-session, per-role cost and latency". Per-model
and per-session cost already ship in `/session` and are better than the roadmap
implies. Per-**role** attribution exists nowhere despite roles being a Phase 1
feature, **latency** is not surfaced anywhere at all, and nothing is queryable
across sessions. Writing this phase as though all of it were missing would rebuild
working code and still leave the real gaps open.

**P4 — The footer fails WCAG 1.4.1.** A user with a red-green colour vision
deficiency gets no signal that the context window is at 91% rather than 40%; the
text is byte-identical and only the SGR colour differs. The same component emits
`↑ ↓ •` with no fallback for terminals or fonts that cannot render them.

**P5 — The exit criterion cannot be checked.** "Session cost reconciles with
provider billing within 5% over a one-week real-usage window" requires a paid
account, a week of wall clock, and a human reading an invoice. No reviewer can run
it, CI can never run it, and it would be discovered as unrunnable at closure — the
failure mode ground rule 3 exists to prevent, and the same one Phase 3 hit with its
median criterion.

## Goals

- [ ] A test that drives a session through the **production** wiring (not by
      constructing a store in the test) observes exactly one durable sample row per
      model request attempt, carrying provider, model, role, outcome, ttft,
      generation, the four token counts, and cost.
- [ ] The ledger's per-session cost aggregate equals `getUsageCostBreakdown()` over
      the same session's entries **exactly** — equality, not a tolerance.
- [ ] A rotated-away attempt (credential failover) records its own row, so attempt
      count exceeds turn count when rotation occurs.
- [ ] `apex-code cost` reports cost and latency grouped by model, by session, and by
      role, over a caller-specified time range, across sessions.
- [ ] `/session` additionally reports per-role attribution and ttft/generation
      latency.
- [ ] With no OTLP endpoint configured, a full turn produces **zero** outbound
      requests attributable to observability (asserted against a `fetch` spy).
- [ ] With an endpoint configured, a turn emits a well-formed OTLP/HTTP JSON trace
      payload whose attribute keys are a subset of the declared allowlist.
- [ ] Rendering the footer with `symbolPreset: "ascii"` produces output containing
      no codepoint above U+007F (assertable by regex over the rendered string).
- [ ] At default settings, the footer's 70% and 90% context thresholds differ from
      the nominal state in a channel other than colour (assertable after stripping
      SGR sequences).
- [ ] Token-usage display honours `off` / `compact` / `full`.
- [ ] An existing version-3 database migrates to version 4 with its
      `command_journal`, `session_leases`, and `cache_entries` contents intact.
- [ ] A ledger write failure (unwritable or absent SQLite) degrades to a diagnostic
      and the turn still completes.

## Non-goals

- [ ] **OTLP metrics signal.** Traces only. The metrics data model's aggregation
      temporality and histogram variants are the expensive part to hand-roll
      correctly, and collectors already derive rate and latency metrics from spans
      as a standard operation. Emitting both would mean building the harder payload
      to produce data the easier one already implies.
- [ ] **The official OpenTelemetry SDK as a dependency.** ~40–60 transitive packages
      into a distributed CLI that currently pins 21 direct dependencies, plus a new
      upstream churn surface, to send a POST whose wire format is public.
- [ ] **Project-directed telemetry.** Nothing in this phase sends anything to the
      Apex Code project. That is ADR 0009 and Phase 9, and conflating the two is the
      specific error ADR 0012 exists to prevent.
- [ ] **Changing the inherited `enableInstallTelemetry ?? true` default.** It
      contradicts the roadmap's Phase 9 "opt-in only" commitment and is recorded
      here so it is not lost, but it is upstream Pi behaviour whose change carries an
      ADR 0003 divergence cost and belongs with ADR 0009.
- [ ] **A user-templatable status line.** A config language, a parser, and a docs
      surface that no user has asked for. The roadmap frames this work as "cheap".
- [ ] **Redesigning the footer's information architecture.** Fix the defects; do not
      reopen the layout.
- [ ] **Wiring `DurableStateDaemon` into a CLI entry point, or fixing Phase 6's
      exit criterion gap.** Verified: `DurableStateDaemon` is constructed only in its
      own test file; no command starts it. That is arguably an open Phase 6
      obligation (its `kill -9`-survives-restart criterion has nothing to restart in
      production), not this phase's to close. `SqliteUsagePerformanceStore` opens the
      durable-state database directly — it does not start, require, or depend on a
      daemon process — so this phase does not need that gap closed to proceed, and
      does not close it either. Flagged, not fixed; see *Risks*.
- [ ] **Measured routing.** `model_performance` was named for driving role→model
      resolution from measurement. Actually routing on it changes which model runs a
      turn — a behaviour change, not observability. This phase makes the measurement
      exist and trustworthy; consuming it is a later decision.
- [ ] **Budgets, limits, or cost forecasting.** Reporting only.
- [ ] **A `/cost` slash command.** It would duplicate `/session`'s existing per-model
      breakdown. The missing dimensions are added to `/session` instead.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Production wiring **(blocking prerequisite)** | Construct a SQLite-backed sample store and pass it as `usagePerformanceStore` on the main session path | `src/core/agent-session-services.ts` |
| Ledger schema | Bump to version 4; extend `model_performance` with `session_id`, `role`, `credential_identity`, `outcome`, `failure_kind`, four token columns, `cost`; drop `usage_totals` | `src/core/durable-state/sqlite.ts` |
| Sample store | New `SqliteUsagePerformanceStore` implementing the existing `UsagePerformanceStore` interface; retire the file-backed one | `src/core/usage-performance-store.ts` |
| Session attribution | The store is constructed **per session** and stamps `session_id` on write. `UsagePerformanceSample` and `instrumentAttempt` are left unchanged | `src/core/usage-performance-store.ts`, `src/core/agent-session-services.ts` |
| Database ownership | `SqliteUsagePerformanceStore` opens the durable-state database directly via `openDurableStateStore`, independent of `DurableStateDaemon` (which stays out of scope — see *Risks*). Every CLI invocation, not only a running daemon, needs its samples recorded, so the store cannot depend on a daemon process existing | `src/core/usage-performance-store.ts` |
| Aggregation | One query module producing cost + latency grouped by model, session, and role over a time range | `src/core/observability/aggregate.ts` (new) |
| Headless surface | `apex-code cost` subcommand reading the aggregation | `src/cli/cost-command.ts` (new), `src/cli/args.ts` |
| Interactive surface | Extend `/session` with role attribution and latency | `src/modes/interactive/interactive-mode.ts:5992` |
| OTLP export | **Implemented as span-per-request-attempt** (narrowed from the span-per-turn/per-tool-call design below, on the record before implementation): one span per `UsagePerformanceSample`, the same unit the ledger records, via `instrumentAttempt` — not a full turn/tool-call span tree, which would require touching `agent-session.ts`'s tool-call lifecycle, a separate integration this phase does not open. OTLP-HTTP JSON via **global `fetch`**, off unless an endpoint is configured. `tool_name` stays in the ADR 0012 allowlist for that future work but is never emitted today. | `src/core/observability/otlp.ts` (new) |
| Settings | `observability.otlpEndpoint`, `observability.otlpHeaders`, `observability.retentionDays`, `terminal.symbolPreset`, `terminal.colorBlindMode`, `terminal.tokenUsageDisplay` | `src/core/settings-manager.ts` |
| Footer | Non-colour channel for context pressure; ASCII glyph fallback; configurable token display | `src/modes/interactive/components/footer.ts` |
| Retention | Prune ledger rows older than `retentionDays` (default 90) on store open | `src/core/durable-state/sqlite.ts` |

**Transport.** The exporter uses global `fetch`, which `http-dispatcher.ts` has
already bound to a proxy-aware, timeout-configured undici dispatcher. Importing
undici directly in the exporter would create a second HTTP configuration and
silently bypass a user's `HTTP_PROXY`. No new dependency is added.

**Span attributes are an allowlist, not a redaction pass.** Only the non-secret
sample fields plus tool names are emitted. No prompt text, no message content, no
tool arguments, no file paths, no credential material — `credentialIdentity` is
already specified as an opaque non-secret label. An allowlist fails closed when a
new field is added to the sample type; a denylist fails open, which is how secrets
leak.

**Seam invariants.** This phase does not touch `beforeToolCall`, `ruleContent`, or
`transformContext`. It reads evidence-adjacent data but does not alter Phase 7's
capture path: the ledger is a *sink*, and a ledger write failure must never fail a
turn (see Goals).

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `usage_totals` table | schema | **Removed** in migration 4. Provably empty — no production writer has ever existed (see *Current state*), so the drop cannot lose data. It duplicated `GROUP BY session_id` over the ledger, and a maintained rollup beside a ledger is a dual write that drifts. |
| `FileUsagePerformanceStore` | code | **Superseded by** `SqliteUsagePerformanceStore`. Removed with its tests; the class was never constructed outside tests, so nothing depends on it. |
| `FileUsagePerformanceStore`'s "Transitional: Phase 6 supersedes this" comment | doc | Removed with the class — the supersession it promised finally happens here. |
| Roadmap ADR table rows for 0005 and 0006 | doc | **Corrected.** Both say `reserved`; `docs/adr/0005-sandbox-boundary-guarantees.md` (148 lines) and `docs/adr/0006-session-format-and-durable-state.md` (97 lines) exist and are Accepted. |
| Roadmap Phase 8 exit criterion | doc | **Amended** — see *Verification*. |

## Risks

**This phase is the first production code ever to open the durable-state
database.** `openDurableStateStore` has run only inside tests and inside
`DurableStateDaemon`, which nothing constructs outside its own test. Every prior
assumption about that subsystem — that it behaves correctly under real filesystem
conditions, concurrent opens from multiple CLI invocations, or an interrupted write —
is untested against production use. `node:sqlite`'s own locking is expected to
handle concurrent-open safely (WAL-mode readers/writers), but "expected to" is not
"proven to" until this phase's own tests exercise it, since no prior phase did.
Mitigation: task 8.1 includes a concurrent-open test (two sessions writing to the
same database) before anything downstream depends on it. Signal that it broke: a
locked-database error surfacing to a user during an ordinary turn, which the
degrade-to-diagnostic Goal exists to catch even if the underlying lock contention
itself isn't fully eliminated.

**Self-measurement.** Phase 7's known hazard, now with a second ledger. Any test
that drives a turn from the repo root writes synthetic rows into the real durable
state and the real cost aggregate. The `inScratchRepo` discipline from ADR 0007 and
`AGENTS.md` § Test discipline applies to every test in this phase without exception.
Signal that it broke: `apex-code cost` reporting nonzero spend on a machine that has
only ever run the test suite.

**Two cost projections drifting.** `getUsageCostBreakdown` computes cost from
session entries; the ledger aggregate computes it from recorded samples. They can
disagree — different inputs, different code. This is the drift ADR 0010 forbids for
tool contracts. Rather than collapse them (which would couple the working TUI
display to unproven infrastructure), the redundancy is **converted into a test**:
their per-session totals must be exactly equal. Signal that it broke: that
equality test failing, which is the point.

**Egress that a user did not ask for.** An observability feature that phones
somewhere by default would be a serious breach of the roadmap's stated posture, made
worse by the inherited default-on install ping already in the tree. Mitigation:
export activates only on an explicitly configured endpoint, and a Goal asserts zero
attributable requests when unconfigured.

**Ledger growth.** One row per request attempt is unbounded over months. Mitigation:
a default 90-day retention prune. Signal: database size growth on a long-lived
install.

**The amendment is self-serving if done carelessly.** Weakening a gate one is about
to be measured against is exactly the move ground rule 3 distrusts. Mitigation: the
amendment is written *before* implementation, it makes the internal criterion
**stricter** (exact equality, not 5%), and it does not discharge the billing
reconciliation — it reclassifies it as an obligation with a named artifact.

## Verification

**Amended exit criterion.** The roadmap's Phase 8 criterion is split at its own
seam. The 5% tolerance survives only where it belongs — against an external bill we
do not control. Internal arithmetic reconciles exactly or it is a bug.

| Part | Status | How |
| --- | --- | --- |
| Every request attempt produces exactly one attributed sample | **Phase gate** | Test through production wiring; attempt count exceeds turn count under forced rotation |
| Ledger per-session aggregate equals `getUsageCostBreakdown()` | **Phase gate** | Exact equality, both projections over one recorded session |
| Zero observability egress when unconfigured | **Phase gate** | `fetch` spy across a full turn |
| Emitted OTLP payload is well-formed and allowlisted | **Phase gate** | Schema assertion over the captured POST body |
| Footer conveys state without colour; ASCII preset is pure ASCII | **Phase gate** | Assertions over rendered output with SGR stripped |
| Version-3 database migrates to 4 without data loss | **Phase gate** | Fixture database round-trip |
| Recorded cost within 5% of a real provider invoice | **Post-landing obligation** | `apex-code cost --since` against a real statement; recorded as a roadmap amendment when performed |

Phase 8 may be marked **landed** on the phase gates. The billing reconciliation is
recorded as outstanding with its artifact named, in the manner Phase 0 used for its
amended criteria and Phase 7 used for its declined calibration claim — never
quietly ticked.

Standard gates: `npx tsgo --noEmit`, `npm run build`, `npx biome check`, and a full
`npm test` run whose failures are characterised against the pre-existing set
(`external-editor`, `radius`, `skills`, `6999-models-json-hot-reload`, and the
CPU-contention seams) rather than reported as green.

## Rollout

Needs `docs/plans/2026-08-15-observability-and-cost.md` — the work spans a blocking
prerequisite, a schema migration, two new modules, two display surfaces, and a
settings addition, with a strict ordering constraint (nothing is verifiable before
the production wiring lands) that requires its own status tracking.

Needs **ADR 0012 — user-directed telemetry export is not project telemetry**,
because the boundary is contested and the failure is irreversible once data leaves a
user's machine:

| | Direction | Consent | Governed by |
| --- | --- | --- | --- |
| OTLP export (this phase) | User's data → **user's own** collector | Explicit endpoint configuration | ADR 0012 |
| Install ping / analytics | Usage data → **the project** | Currently `true` by default (inherited) | ADR 0009, Phase 9 |

0012 is the next free number: `0001`–`0008`, `0010`, and `0011` exist; `0009` stays
reserved for Phase 9 per the roadmap's rule that an ADR written ahead of its phase
takes the next free number rather than a reserved one.
