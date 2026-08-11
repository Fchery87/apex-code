# Apex Code — roadmap

*A provider-agnostic agentic harness forked from Pi.*

**Status:** Active — Phase 0 landed; Phase 1 specification active · **Created:** 2026-08-08 · **Last updated:** 2026-08-10

> **Name settled: `apex-code`.** Binary `apex-code`, config directory
> `~/.apex-code/`, session paths, and the npm package name. Task 0.1 verified the npm
> coordinate is now claimed; token-free Trusted Publishing was proven by the published
> `0.0.1-alpha.1` prerelease. The bootstrap token is revoked, and both packages
> disallow token-based publishing.

This is the **program** document: what gets built, in what order, and the measurable
condition each phase must satisfy to be considered done. It is permanent and
status-tracked.

It is deliberately **not** an execution breakdown. Per `AGENTS.md` § Plan Documents,
each phase gets its own `docs/specs/YYYY-MM-DD-<slug>.md` (written when the previous
phase exits) and `docs/plans/YYYY-MM-DD-<slug>.md` (written when that spec is
approved, deleted on completion). Nine speculative plan docs written today would all
be wrong by Phase 3.

---

## Founding decisions

| Decision | Choice | Consequence |
| --- | --- | --- |
| Fork depth | Fork `pi-coding-agent` + `pi-agent-core`; consume every other Pi package | Full control of loop, tools, permissions, sessions. 35 providers keep updating for free. Provider work rides `registerProvider()`. Implemented as a full-tree graft with the consumed packages frozen and CI-asserted — see ADR 0001's amendment. |
| Target bar | Distributable OSS product | Versioned releases, install/update, docs, **session-format back-compat**, security posture, opt-in telemetry. Constrains every phase, not just Phase 9. |
| Thanos disposition | Evidence capture in core; SpecEngine + governance policy stay a bundled extension | Evidence recorded at the source (the bash tool knows its own exit code). Policy layer stays independently testable and switchable-off. |
| License | MIT (Pi is MIT across the whole monorepo; Thanos is already MIT) | Attribution required. Clean to distribute. |
| Name | **Apex Code**, identifier `apex-code` | Binary `apex-code`, config dir `~/.apex-code/`, repo `Fchery87/apex-code`. Bare `apex` was rejected: the npm coordinate is held by an abandoned 2022 stub (`v0.1.2`, "Work In Progress", untouched since 2022-06-13), which would have forced a scope and left users installing one name and running another. |
| npm coordinate | `apex-code` — **unscoped, verified free** | No scope needed, so the install command and the binary match. Claim it before first publish (Task 0.5); until then this is reversible. |

---

## Ground rules

**1. Clean-room with respect to `c-code`.** The leaked Claude Code source is
`UNLICENSED`. It is a **specification of behavior**, never a source to copy from.
No file, function, string, or type definition moves from it into this repo. It must
not be checked out in the build environment or in any agent's working tree during
implementation. Descriptions of its behavior in `docs/research/` are fine and are how
its ideas legitimately enter the project. This is ADR-0002 and it is the single
constraint most likely to be violated by accident under time pressure.

**2. Upstream is a dependency relationship, not a one-time copy.** Pi ships fast, and
Phase 0 measured how fast: one *patch* release moved 57 files and ~2,000 lines inside
the two packages we fork. A fork without merge discipline is dead in two months.
ADR 0003 sets the cadence, the ceiling, and the abandonment tripwires.

**3. Every phase exits on a number, not a feeling.** The strongest thing in the
current Thanos docs is the `≥50% keeps src/spec/` gate. Every phase below carries a
criterion someone other than the author can check. Where a threshold depends on a
baseline that does not exist yet, it is marked **Phase 0 baseline: 935 tokens** (median of 1,117 un-compacted and 752 compacted turn-20 runs) rather than
invented here.

**4. Safety floor and context budget precede capability.** Permissions (2) and
context engineering (3) both gate the tool surface (4). Adding tools first means
retrofitting permissions one tool at a time, and shipping a harness that is more
capable and measurably worse.

---

## Phase map

```
0  Fork foundation ──┬──► 1  Provider & model layer
                     │
                     ├──► 2  Permissions & sandbox ──┐
                     │                               ├──► 4  Tool surface ──► 5  Delegation
                     └──► 3  Context engineering ────┘
                                                          │
   6  Durable state & daemon ──────────────────────────────┘
   7  Evidence & verification      8  Observability & cost      9  Release hardening
```

| Phase | Name | State | Spec | Plan |
| --- | --- | --- | --- | --- |
| 0 | Fork foundation | **landed** — 10 of 10 tasks | [spec](specs/2026-08-08-fork-foundation.md) | — |
| 1 | Provider & model layer | **specified** — planning next | [spec](specs/2026-08-10-provider-and-model-layer.md) | — |
| 2 | Permissions & sandbox | not started | — | — |
| 3 | Context engineering | not started | — | — |
| 4 | Tool surface | not started | — | — |
| 5 | Delegation & multi-agent | not started | — | — |
| 6 | Durable state & daemon | not started | — | — |
| 7 | Evidence & verification | not started | — | — |
| 8 | Observability & cost | not started | — | — |
| 9 | Release hardening | not started | — | — |

---

## Phase 0 — Fork foundation

**Objective.** A fork that builds, tests, releases, takes upstream changes, and can
**measure itself**. Nothing after this is trustworthy without the last item.

**Why first.** Two things here are load-bearing for the whole program: the upstream
merge discipline (or the fork rots) and the replay corpus (or every later phase's
exit criterion is unmeasurable).

**Scope.**
- **Task 0.1 — claim the name.** ✅ Done. Repo `apex-code`, binary `apex-code`, config
  dir `~/.apex-code/`, npm `apex-code` (unscoped, verified free), MIT license + Pi
  attribution, `CONTRIBUTING`. Task 0.5 claimed it with the first pre-alpha publication.
- **Task 0.2 — fork.** ✅ Done. Full-tree graft at `v0.84.0`, rehearsal merge to
  `v0.84.1`. Consumed packages frozen and CI-asserted (ADR 0001, amended).
- Build, typecheck, lint, test, and a release pipeline that produces an installable
  artifact from day one. A release path added in Phase 9 is a release path that has
  never been exercised.
- **Upstream merge rehearsal.** ✅ Done, and it disproved its own premise: at fork+0
  divergence the hunk count is 0 by construction, so ADR 0003's ceiling basis moved
  past Phase 2. Upstream churn is the honest Phase 0 metric.
- **Replay corpus + headless metrics harness.** A fixed set of recorded sessions
  (start from the real transcripts in `.omp`, `.prime`, `.atomic`) replayable
  offline, emitting deterministic metrics: context tokens at turn N, system-prompt
  token count, tool-call counts, wall time, cost. This is the instrument every later
  gate reads.
- Port the doc conventions: `docs/adr/`, `docs/specs/`, `docs/plans/`, `AGENTS.md`.

**Exit criterion.** CI green on three platforms. One upstream release merged with the
hunk count recorded. Replay corpus runs headless and produces identical metrics across
two consecutive runs on the same input.

**Progress against it** (verified, not asserted — see `docs/upstream-log.md`):

| Criterion | State |
| --- | --- |
| CI green on three platforms | **met as amended.** Run [`31454315906`](https://github.com/Fchery87/apex-code/actions/runs/31454315906) passed the frozen-package gate and concluded success. Ubuntu passed all required steps. macOS passed Build and Check, with one advisory inherited timing failure; Windows passed Build and Check, with its characterised advisory platform failures. The amended criterion is: *Linux green, macOS and Windows characterised.* |
| Published artifact installs and completes a provider turn | **met.** `apex-code@0.0.1-alpha.0` clean-installed from npm, reported the expected version, passed registry signature/attestation audit, and completed a configured Google turn. Release run [`31326901954`](https://github.com/Fchery87/apex-code/actions/runs/31326901954). |
| Upstream release merged, hunk count recorded | **met, and the criterion was wrong.** `v0.84.0` → `v0.84.1` merged: 1 conflicted hunk, 0 in forked paths. But at fork+0 divergence a hunk count is zero by construction and cannot found a ceiling. ADR 0003 was amended to move the ceiling basis past Phase 2; the honest Phase 0 metric is upstream churn — 57 files / ~2,000 lines per patch release. |
| Replay corpus deterministic across two runs | **met.** Eight scrubbed synthetic native-v3 sessions replay offline through the Agent loop. The stable metrics schema and lexically ordered corpus output are byte-identical across consecutive runs (Task 0.9). |

Two criteria above are recorded as *amended* rather than ticked. Phase 0 closed against
the amended wording, not the original — a criterion that turned out to be unmeasurable
was corrected on the record, never quietly marked done.

**Risks.** The corpus is the task most likely to be skipped as "not real work." It is
the highest-leverage item in the phase. Sessions also carry live API keys and repo
paths — the corpus needs a scrubbing step before anything is committed.

---

## Phase 1 — Provider & model layer

**Objective.** Provider- and model-agnostic in the operational sense, not just the
"can reach 35 endpoints" sense. `pi-ai` already delivers reach; this phase adds
everything above it.

**Scope.**
- **Credential pool** with failover — modeled on OMP's `auth_credentials` +
  `auth_credential_blocks` + `auth_credential_refresh_leases` + `identity_key`. A
  rate-limited or blocked key rotates rather than failing the turn.
- **Model roles** (`default` / `plan` / `tiny` / `designer`, extensible) — OMP's
  `modelRoles`. This, not a single `defaultModel`, is the right provider-agnostic
  answer to "which model for which job."
- **Fallback chains** per role, with the recovery semantics from c-code's
  `fallbackModel`.
- **Measured routing**: a `model_perf` table (`ttft_ms`, `gen_ms`, sample counts) so
  role→model resolution is driven by measurement, not guesswork.
- **Credentials out of plaintext config.** Both `.omp/agent/models.yml` and
  `.prime/agent/models.json` currently hold a live API key in cleartext. The fork
  reads keys from the credential store or env, never from a committed config file.

**Exit criterion.** A forced 429 on the primary credential rotates to a secondary and
the turn completes (test). Role routing resolves to distinct models per role from one
config. Per-turn recorded cost is within 5% of provider-reported cost across the
replay corpus. No API key appears in any file the config loader writes.

**Risks.** Cost tables drift constantly. Treat `cost` as data to refresh, and add a
staleness warning rather than silently reporting wrong numbers.

---

## Phase 2 — Permissions & sandbox

**Objective.** The safety floor. Pi has none — `security.md` is explicit that project
trust is "only an input-loading guard." This is the largest single gap between Pi and
a harness you can run unattended.

**Why here.** The `ruleContent` contract must exist before the tools that interpret
it. Every tool added before this phase is a retrofit.

**Scope.**
- Rule model: `{source, ruleBehavior: allow|deny|ask, ruleValue: {toolName, ruleContent?}}`,
  with `ruleContent` interpreted **by the tool** (so `Bash(git commit:*)` stays a
  bash-local concern).
- Source precedence, explicit and test-covered: `policy > flag > local > project > user > cliArg > command > session`.
- Modes: `default`, `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk`.
- `PermissionUpdate` as a typed, persisted operation (`addRules` / `replaceRules` /
  `removeRules` / `setMode`) against explicit destinations.
- Interception at `beforeToolCall` — the seam Pi's `Agent` already exposes.
- **OS-level sandbox** underneath: filesystem read/write restriction, network host
  allowlist, a violation store, and an interactive escalation callback. ADR-0005
  must state plainly what the boundary does and does not guarantee — Pi's own
  security doc is right that a half-sandbox misread as a real one is worse than none.

**Exit criterion.** A test asserts **every** registered tool passes through the
permission gate — no exceptions list. Precedence verified across all eight sources.
The sandbox blocks a write outside the workspace and a request to a non-allowlisted
host, and both surface as violations rather than silent failures.

**Risks.** Sandbox implementation is platform-divergent and is where this phase will
overrun. Ship the rule model first; it is independently valuable and unblocks Phase 4
on its own.

---

## Phase 3 — Context engineering

**Objective.** Make a large tool surface and long sessions affordable, before either
exists.

**Scope.**
- **Tool-result eviction** ("microcompact"): evict old tool results in place for a
  whitelist of replayable tools (read, shell, grep, glob, web search, web fetch, edit,
  write), leaving a marker. Reclaims most of the context cost with no summarization
  call and no loss of conversational structure. The single highest-value context
  technique in the systems reviewed.
- **Deferred tool schemas**: tools announce by name; full JSONSchema loads on demand
  via a search tool. MCP tools deferred by default with an always-load override.
- Keep Pi's compaction and **branch summarization** — the latter falls out of the
  tree-structured session format and c-code has no equivalent.
- Add reactive compaction on `prompt_too_long`, distinct from threshold-based
  auto-compaction.

**Exit criterion.** On the replay corpus: median context tokens at turn 20 down ≥40%
from the **Phase 0 baseline of 1,563 tokens** (median of the two turn-20-capable fixtures: 1,745 un-compacted and 1,380 compacted), baseline system-prompt tokens down from **707 tokens** by the deferred-schema
saving, and **no regression in task completion**. That last clause is the one that
matters — the other two are trivially gameable alone.

**Risks.** Eviction interacts with prompt caching: evicting a prefix invalidates the
cache and can cost more than it saves. Measure cache hit rate as part of the gate, not
after.

---

## Phase 4 — Tool surface

**Objective.** Close the gap between Pi's seven core tools and a harness that can
actually do the work.

**Scope**, in dependency order: delegation entry points (Phase 5 builds them out),
`TodoWrite`, web search + fetch, plan mode, structured user questions, worktree
isolation, LSP. Each tool ships with its permission rules, its `ruleContent` grammar,
and tests — a tool without a rule grammar is not done.

**Exit criterion.** Every tool has permission rules and tests. Total system-prompt
token count stays under the ceiling established in Phase 3 — the deferred-schema
mechanism is what makes this possible, and this gate is what proves it worked.

---

## Phase 5 — Delegation & multi-agent

**Objective.** Subagents that cannot exceed their parent's authority.

**Scope.** Build on `pi-subagents`' decomposition rather than from zero — its
`capability-ceiling`, `preflight`, and `control-channel` are the right primitives, and
existing ADRs 0009 and 0024 already govern that dependency. Add Prime's recursion
depth guard (`rlmDepth` in the session header) and per-subagent artifact isolation.
Background work with retrievable results; inter-agent messaging only if a concrete
use case demands it.

**Exit criterion.** A child agent cannot obtain a grant its parent lacks (test).
Recursive delegation terminates at a bounded depth. Subagent artifacts never write
outside their own directory.

---

## Phase 6 — Durable state & daemon

**Objective.** Survive crashes and support more than one client.

**Scope.** SQLite for auth, usage, model performance, and cache; FTS5 prompt history;
JSONL stays the session-of-record because the `id`/`parentId` tree is too good to give
up. Daemon + clients. Command journaling and snapshot cache (Prime's `daemon-workers/`)
so a long-running command survives a restart. Session leases for multi-client attach.
Git provenance in the session header.

**Exit criterion.** `kill -9` the daemon mid-command; on restart the command's state
is recovered from the journal. Two clients attach to one session without corrupting
it.

---

## Phase 7 — Evidence & verification

**Objective.** Distinguish "the agent said it passed" from "it passed." No other
harness reviewed can do this; it is the differentiator.

**Scope.** Move evidence *capture* into core — the bash tool records its own exit
code and argv, the edit tool its own patch hash and paths, the test runner its own
normalized executable. Port the existing `EvidenceRecord` union. Keep the SpecEngine,
gates, and governance policy as a **bundled extension**, switchable off and
independently testable — that separability is how the layer's calibration was earned.

**Exit criterion.** Evidence for bash, edit, write, and test is captured at the source
with no post-hoc reconstruction. Gate false-positive rate stays under the threshold
already established by the existing `gatedFailures()` work.

**Risks.** The known self-measurement hazard: tests that drive a turn from the repo
root file synthetic rows into the evidence ledger. Carry the `inScratchRepo`
discipline forward from day one.

---

## Phase 8 — Observability & cost

**Objective.** Know what it costs and where the time goes.

**Scope.** Per-model, per-session, per-role cost and latency. OpenTelemetry export.
A status line worth reading. Carry OMP's accessibility settings across —
`symbolPreset: ascii`, `colorBlindMode`, configurable token-usage display. Cheap, and
almost nobody does it.

**Exit criterion.** Session cost reconciles with provider billing within 5% over a
one-week real-usage window.

---

## Phase 9 — Release hardening

**Objective.** A stranger installs it and it works.

**Scope.** Versioned releases and an update path (exercised since Phase 0, hardened
here). Install on all supported platforms. **Session-format migration**: the
distributable posture means a format bump must migrate existing sessions, not orphan
them — Pi's own v1→v2→v3 auto-migration is the model. User documentation, not just
`docs/`. Security disclosure process. Opt-in-only telemetry with a published list of
what is collected (ADR-0009). Third-party attribution.

**Exit criterion.** Fresh install succeeds on all supported platforms from the
published artifact. An upgrade across a session-format version bump preserves and
correctly renders pre-upgrade sessions. A security disclosure path is published and
monitored.

---

## ADRs to write

These are the irreversible or contested calls. Each gets settled once, in
`docs/adr/`, and stops being re-argued.

Numbers are allocated when an ADR is **written**, not when its phase is forecast.
Rows below without a written file are reservations; an ADR written ahead of its phase
takes the next free number instead of a reserved one.

| # | Decision | Phase | Written |
| --- | --- | --- | --- |
| 0001 | Fork boundary: `coding-agent` + `agent-core` forked; `pi-ai`, `pi-tui` consumed | 0 | ✅ |
| 0002 | Clean-room rule regarding `c-code`; behavior may be described, code never copied | 0 | ✅ |
| 0003 | Upstream merge cadence, patch-surface ceiling, and abandonment tripwire | 0 | ✅ (ceiling pending) |
| 0004 | Permission rule model and source precedence | 2 | reserved |
| 0005 | What the sandbox boundary does and does not guarantee | 2 | reserved |
| 0006 | Session format ownership and the migration guarantee owed to users | 6 | reserved |
| 0007 | Evidence capture in core; policy layer stays a bundled extension | 7 | reserved |
| 0008 | Delegation authority: `pi-subagents` dependency vs. owning it | 5 | reserved |
| 0009 | Telemetry: opt-in only, and exactly what is collected | 9 | reserved |
| 0010 | One canonical tool contract, declared by the tool and never re-derived | pre-2 | ✅ |

## Cross-phase contracts

Some interfaces are written to by several phases and cannot be designed inside any
one phase's spec. They live in `docs/architecture/contracts.md`, which records each
as **settled** (specified, with an ADR) or **open** (consumers and questions
recorded, decision deferred to the phase that first writes to it).

| Contract | Status | Consumers | Settle by |
| --- | --- | --- | --- |
| Tool contract | Settled — ADR 0010 | 2, 3, 4, 5, 7 | done |
| Context pipeline order | Open | 3, 7 | start of Phase 3 |
| Session entry schema | Open | 1, 5, 6, 7, 9 | start of Phase 6 (entries logged as they land from Phase 1) |

---

## Explicitly not building

Defended non-goals, so they stop coming back:

- **A React/Ink TUI.** `pi-tui` has two runtime dependencies. Ink is the largest
  copy-temptation in `c-code` and would import a rendering framework and its startup
  cost for aesthetics the terminal does not reward.
- **Our own provider layer.** `pi-ai` is the best thing in any of the reviewed
  systems and the part of Pi that needed no improvement. Rewriting 35 providers ×
  9 API dialects is the most tempting and most wasteful thing available.
- **A feature-flag / experimentation platform.** `c-code` threads `feature()` calls
  through everything and pulls in a full experimentation vendor. A single-maintainer
  OSS harness does not carry that.
- **A monolithic query loop.** Take c-code's recovery *behaviors* — output-token
  recovery, reactive compaction, turn caps, budget tracking — onto Pi's loop
  structure. Its 1730-line generator over mutable state is not the shape to copy.
- **A model-evaluation suite.** Already litigated in
  `docs/plans/2026-07-27-harness-simplification-plan.md` Task 1.1: the one that
  existed called no model and fabricated its numbers. The Phase 0 replay corpus is
  the honest, affordable version. Re-proposing a full eval suite must re-open that
  framing decision, not resume a paused phase.
