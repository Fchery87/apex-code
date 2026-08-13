# Spec: Context engineering — tool-result eviction, deferred schemas, and the context pipeline order

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Status | `Draft` |
| Created | `2026-08-13` |
| Last updated | `2026-08-13` |
| Roadmap phase | `3 — Context engineering` |
| Tracking issue/PR | none |
| Compatibility posture | **Preserves compatibility, with one deliberate in-place transcript rewrite.** See below. |

**Compatibility posture.** The session format is unchanged: eviction rewrites the
*outbound provider context*, not the stored session. A session written before this
change replays identically after it, and `fixtures/corpus/` is not re-recorded — that
is the property the Phase 0 replay gate exists to protect, and re-recording the corpus
to make a context change look good would destroy the only baseline this phase is
measured against. The one compatibility obligation is the eviction marker itself: it
becomes visible in what the model sees, so a session resumed on an older build sends
full results again rather than markers. That degrades gracefully (more tokens, same
answers) and needs no migration. Deferred schemas change the tool-announcement shape
inside a request, which is a provider-boundary concern, not a stored-state one. No
settings key is removed; the new behavior is introduced with defaults that can be
turned off per-tool through the contract that already exists.

## Executive summary

Add tool-result eviction ("microcompact") and deferred tool schemas so a large tool
surface and a long session stay affordable, and settle the **context pipeline order**
contract that compaction, eviction, and schema resolution all share. Eviction replaces
old, regenerable tool results with a marker in the outbound context, reclaiming the
bulk of context cost with no summarization call. Deferred schemas announce tools by
name and load full JSONSchema on demand. Both consume `ContextSpec`, which every tool
already declares but nothing reads yet.

## Context and motivation

- `docs/roadmap.md` § Phase 3 — the phase this implements and the exit criterion it
  serves. **Two defects in that criterion are corrected here; see "The problem."**
- `docs/architecture/contracts.md` § 1.3 `context` — `ContextSpec` is settled and
  declared by all seven tools; this phase is its first consumer.
- `docs/architecture/contracts.md` § 2 "Context pipeline order — open" — explicitly
  marked **settle by: start of Phase 3**, with four open questions. Answering them is
  a required deliverable of this spec, not an optional extra.
- `docs/research/2026-08-08-harness-comparative-review.md` § Finding 4 — the behavioral
  description of eviction and deferred schemas, and the prompt-cache caveat. Per ADR
  0002 this research doc is the **only** channel through which these ideas enter the
  repo; nothing is copied from the unlicensed source.
- ADR 0010 — one canonical tool contract. Eviction must not re-derive a second notion
  of "evictable" alongside `resultRecoverable`.

## Current state

**The replay harness works and its metrics are real.** `packages/coding-agent/src/testing/replay/runner.ts:212`
replays a corpus fixture fully offline, and `metrics.ts:26` emits `contextTokensByTurn`,
`systemPromptTokens`, and `cacheHitRate`. Measured against `fixtures/corpus/` on the
current tree (`replayCorpus()`, 2026-08-13):

| Fixture | Turns | Turn-20 context tokens | `systemPromptTokens` | `cacheHitRate` |
| --- | ---: | ---: | ---: | ---: |
| `long-multi-turn.jsonl` | 22 | **1,117** | 707 | 0.0000 |
| `compacted-session.jsonl` | 22 | **752** | 707 | 0.0000 |
| `long-tool-heavy.jsonl` (added 2026-08-13) | 22 | **15,272** | 960 | **0.8569** |
| all six others | 1–3 | n/a (fewer than 20 turns) | 707 | 0.0000 |

Median turn-20 = **1,117**. Before `long-tool-heavy` was added it was 934.5 — a median
over three values is the middle one, not a mean of two.

`long-tool-heavy.jsonl` was authored as part of grounding this spec, because the two
pre-existing turn-20 fixtures contain **zero tool calls and zero tool results** and
every fixture recorded `cacheRead: 0`/`cacheWrite: 0`. It carries 10 interleaved
`read`/`grep` calls and realistic cache usage; of its 15,272 turn-20 tokens, ~14,300
are evictable tool output. Its `systemPromptTokens` is 960 rather than 707 because it
exercises `grep` beyond the four default tools.

**`ContextSpec` is declared but unconsumed.** All seven tools answer both axes
(`contract.ts:96`, defaults at `contract.ts:136`):

| Tool | `resultRecoverable` | `deferSchema` |
| --- | --- | --- |
| `read`, `edit`, `write`, `grep`, `find`, `ls` | `true` | `false` |
| `bash` | **`false`** | `false` |

Grepping `src/` outside the tool definitions themselves returns no reader of
`resultRecoverable`, `evictionMarker`, `deferSchema`, or `outputBudgetTokens`. Phase 3
is their first consumer.

**Compaction is upstream Pi's, and it is solid.** `core/compaction/compaction.ts`
provides `shouldCompact()` (threshold on `contextWindow - reserveTokens`, line 235),
`findCutPoint()`, `prepareCompaction()`, and `compact()`; `branch-summarization.ts`
handles tree navigation. `agent-session.ts:2087` drives threshold-based auto-compaction.
This is upstream behavior, not something Apex Code has changed — the merge cost of
touching it is ADR 0003's concern, which is why this spec adds a stage around it rather
than rewriting it.

**Correction (2026-08-13, task 3.4 investigation):** reactive compaction on provider
`prompt_too_long` already fully exists and is already distinct from the threshold path
— it is not merely "the seam that item lands on," as this section originally hedged.
`isContextOverflow()` (`packages/ai/src/utils/overflow.ts`) matches real provider
overflow errors across ~20 providers; `_checkCompaction` in `agent-session.ts` branches
on it with its own `reason: "overflow"`, wired independently of the token-count-based
`"threshold"` branch in the same function, and both are tagged distinctly on the
`compaction_start`/`compaction_end` events. `git log -S'"overflow"'` traces this to
upstream Pi (`a38e61909`, pre-fork) — inherited, not something Apex Code built. Existing
integration coverage (`test/agent-session-auto-compaction-queue.test.ts`) already
exercised it before this phase. The one genuine gap was a single, independent pin
proving the two paths are distinct under one assertion; that test now exists
(`test/context/reactive-compaction.test.ts`). No production code changed for this item.

## The problem

Four concrete problems, the first two of which are defects in the phase gate itself
and were found by running the harness rather than reading the roadmap.

**1. The stated exit criterion is measured against a baseline that does not
reproduce — and as written the gate is vacuous.** `docs/roadmap.md` § Phase 3 cites a
"Phase 0 baseline of 1,563 tokens (median of the two turn-20-capable fixtures: 1,745
un-compacted and 1,380 compacted)." The real measured values are 1,117 and 752, median
935. The roadmap's own ground rule 3 (`docs/roadmap.md:56`) cites **935 (1,117 / 752)**
— which reproduces exactly. The two passages disagree, and the Phase 3 one is wrong.

This is not cosmetic. ≥40% off the erroneous 1,563 is a target of **≤938 tokens**. The
corpus already sits at **935** with no work done at all, so the gate as written passes
on day one and measures nothing. Off the then-true 935 baseline the target is **≤561**
(itself since superseded — see Problem 2 and Verification, where adding a fixture the
gate was missing moves the baseline to 1,117 and the target to ≤670),
which requires real reduction. A phase whose exit criterion is satisfied before the
phase begins cannot be checked by someone other than the author, which is exactly what
ground rule 3 demands.

**2. The gate was structurally blind to the phase's headline technique — now fixed.**
Both pre-existing turn-20 fixtures contain zero tool calls and zero tool results
(verified by JSON parse, not grep). Tool-result eviction, which the research doc calls
"the highest-value context technique in the review," had **nothing to evict** in either
and could not move the gate metric by one token. The corroborating measurement: a
single tool result in `heavy-tool-output.jsonl` costs >8,000 tokens, against 410 tokens
for an entire 22-turn tool-free conversation — tool results are roughly 18× the cost of
everything else, and the gate contained none of them. Closed by adding
`long-tool-heavy.jsonl` (commit `280616593`).

**3. The cache-hit-rate signal the Risks section requires could not be produced — now
fixed.** The Risks entry says "Measure cache hit rate as part of the gate, not after,"
and `contracts.md` § 2 says the ordering decision "must be made against that number,
not in the abstract." Every recorded response carried `cacheRead: 0`/`cacheWrite: 0`
(44 of each in `long-multi-turn.jsonl`), so `cacheHitRate` was 0.0000 everywhere.
`long-tool-heavy.jsonl` now reports **0.8569**, the corpus's first real value.

**4. The scope's eviction whitelist contradicts a tool's own contract.** The roadmap
lists the whitelist as "(read, shell, grep, glob, web search, web fetch, edit, write)"
— shell included. `bash.ts` declares `resultRecoverable: false`, and per
`contracts.md` § 1.3 "**ONLY** recoverable results may be evicted." Following the
roadmap's whitelist would evict `bash` results in defiance of the contract, which is
precisely the second-independent-classification failure ADR 0010 exists to prevent.

**5. Nothing reads `ContextSpec`.** Seven tools answer two questions each and no code
consults the answers, so the declarations are currently unverified assertions.

## Goals

- [ ] Median turn-20 context tokens across the three turn-20-capable corpus fixtures is
      **≤670** (≥40% below the measured baseline of 1,117), reported by `replayCorpus()`.
- [ ] **`long-tool-heavy.jsonl`'s turn-20 drops ≥80% on its own** (15,272 → ≤3,054).
      This is a separate, per-fixture assertion because the median under-credits
      eviction: the heavy fixture is the outlier, so a median can improve without
      eviction doing anything. Deferred schemas alone cannot reach ≥80% here — they can
      cut at most the 960-token static prefix, ~6% of this fixture — so only working
      eviction passes it.
- [ ] `systemPromptTokens` is **below 707** on the six-and-two default-tool fixtures and
      **below 960** on `long-tool-heavy`, with at least one tool set to
      `deferSchema: true`, reported by the same harness.
- [ ] **No regression in task completion**: `turnsCompleted` and the response/tool-result
      equality assertions in `replay()` (`runner.ts:329`) hold unchanged for every
      fixture. This is the clause that matters; the other two are gameable alone.
- [ ] Eviction evicts a result **only** when its tool declares `resultRecoverable: true`;
      a test asserts a `bash` result survives eviction while a `read` result does not.
- [ ] The context pipeline order is settled in writing, with all four
      `contracts.md` § 2 questions answered, and `contracts.md` § 2 is moved from
      **open** to **settled**.
- [ ] `docs/roadmap.md` § Phase 3's baseline figures are corrected to the measured
      values, and ground rule 3 and the Phase 3 criterion agree.
- [x] The corpus gains a fixture that carries nonzero `cacheRead`/`cacheWrite`, so
      `cacheHitRate` is a real signal rather than a constant zero. **Done —
      `long-tool-heavy.jsonl`, `280616593`, `cacheHitRate` 0.8569.**
- [x] Reactive compaction on provider `prompt_too_long` is distinct from, and testable
      independently of, threshold-based auto-compaction. **Already existed
      (inherited from upstream Pi, `a38e61909`) — see the "Current state" correction
      above. `test/context/reactive-compaction.test.ts` is the new independent pin.**

## Non-goals

- [ ] **Not re-recording the existing `fixtures/corpus/` entries to change the
      baseline.** The corpus is the only artifact that makes this phase's number
      checkable by someone else; adjusting it in the same phase that is measured against
      it destroys the measurement. *Adding* `long-tool-heavy.jsonl` is a deliberate
      exception, taken before implementation and recorded in the corpus README: without
      it the gate cannot observe eviction at all. The two pre-existing turn-20 fixtures
      are byte-untouched, and their individual numbers (1,117 and 752) are unchanged —
      only the median moved, and visibly.
- [ ] **Not rewriting Pi's compaction.** It is upstream code that works, and ADR 0003
      prices wide refactors of forked files in merge cost. Eviction is added as a stage
      around compaction, not inside it.
- [ ] **Not implementing the on-demand schema *search* tool.** Deferred schemas need a
      loader; a searchable tool-discovery surface is Phase 4's fifteen-tool problem, and
      building it now would design a search UX against seven tools and then rebuild it.
      This phase ships the deferral mechanism and an explicit load path.
- [ ] **Not MCP-tool deferral defaults.** The roadmap mentions "MCP tools deferred by
      default with an always-load override." Apex Code's MCP surface is not in this
      phase's dependency path, and the override belongs with the MCP config work rather
      than ahead of it. `deferSchema` is per-tool from day one, so the default flips
      later without redesign.
- [ ] **Not time-based eviction.** `contracts.md` § 2 flags that any wall-clock
      dependence needs an injectable clock to keep the replay gate deterministic.
      Position-and-budget-based eviction avoids the problem outright; adding a clock to
      buy a policy nobody has asked for is unjustified complexity.

## Proposed solution

### The context pipeline order — settling `contracts.md` § 2

The four open questions, answered:

**Eviction runs before compaction.** Compaction is the expensive, lossy, irreversible
stage: it makes a summarization call and replaces structure with prose. Eviction is
cheap and structure-preserving. Running eviction first means compaction is reached
later and less often, and when it is reached it summarizes a shorter transcript. The
objection recorded in `contracts.md` — that compaction then summarizes markers rather
than content — is real but bounded: only `resultRecoverable: true` content is ever
behind a marker, so anything the summary loses is by construction regenerable. The
reverse order pays a summarization call on content that was about to be dropped, which
is the worse trade.

**Prompt-cache interaction: measured, not assumed — and the honest answer is that this
corpus cannot decide it.** Problem 2 above means `cacheHitRate` is a constant zero
today. Rather than assert a cache-safe design against a number that does not exist,
this spec requires the corpus gain a cache-carrying fixture (Goal 7) **before** the
ordering is locked, and the eviction stage is built cache-aware in shape: it evicts a
contiguous run from the *oldest* end of the transcript, never a hole in the middle.
Prefix-oldest eviction moves the cache boundary forward monotonically instead of
punching a hole that invalidates everything after it. If the new fixture shows
prefix-oldest eviction still costs more than it saves, that is a finding to record in
an ADR, not a result to design around silently.

**Evidence survival:** eviction touches only the outbound provider context and never
the stored session, so any Phase 7 evidence path reading the session is unaffected by
construction. The spec adds a test asserting the on-disk session is byte-identical
before and after an eviction pass, so a future evidence path that reads back from
message content fails loudly here rather than silently in Phase 7.

**Determinism:** eviction is a pure function of (message list, per-tool `ContextSpec`,
token budget). No clock, no randomness, no I/O. The replay gate's identical-metrics
requirement holds without an injectable clock.

Resulting order at the `transformContext` seam:

```
deferred-schema resolution → tool-result eviction → compaction (threshold or reactive)
```

Schema resolution is first because it changes the static prefix, which both later
stages measure themselves against.

### Components

| Component | Change | File(s) |
| --- | --- | --- |
| Eviction stage | New pure function: takes messages + contract lookup + budget, returns rewritten messages, evicting the oldest contiguous run of `resultRecoverable: true` results | `core/context/eviction.ts` (new) |
| Marker rendering | Substitute `ContextSpec.evictionMarker`, falling back to a default naming the tool and original size | `core/context/eviction.ts` |
| Contract lookup | Read `resultRecoverable` via the existing canonical projection; no second classifier | consumes `buildToolContractSnapshot()` |
| Deferred schemas | Announce `deferSchema: true` tools by name/description with an empty parameter schema; explicit load path materializes the real one | `core/context/deferred-schemas.ts` (new) |
| Pipeline wiring | Apply the three stages in the settled order | `core/agent-session.ts` |
| Reactive compaction | **Already existed** (inherited from upstream Pi, `a38e61909`); added one pinning test proving it is distinct from the threshold path | `test/context/reactive-compaction.test.ts` (new) |
| Cache fixture | Add one corpus fixture carrying nonzero `cacheRead`/`cacheWrite` | `fixtures/corpus/` |
| Contract doc | Move § 2 from open to settled, recording the answers above | `docs/architecture/contracts.md` |
| Roadmap correction | Fix Phase 3's baseline figures to the measured values | `docs/roadmap.md` |

**Seam invariant.** `transformContext` must remain a pure rewrite of the outbound
message list that never mutates stored session entries. All three stages are pure
functions over the message list; the eviction test asserting session-file byte-equality
is what holds the invariant honest.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `docs/roadmap.md` Phase 3 baseline figures (1,563 / 1,745 / 1,380) | doc | **Removed** — replaced with the measured median **1,117** over three fixtures (752 / 1,117 / 15,272); ground rule 3's 935 is superseded by the same measurement and updated with it |
| `docs/architecture/contracts.md` § 2 "open" status and its four open questions | doc | **Superseded** by the settled ordering recorded in this spec |
| Roadmap scope phrase "whitelist of replayable tools (read, shell, …)" | behavior | **Superseded** by `ContextSpec.resultRecoverable` as the single predicate; `bash` is not evicted, per its own contract |

No code is deleted — the two new stages are additive, and compaction is deliberately
left intact (see Non-goals).

## Risks

**Eviction invalidates a cached prefix and costs more than it saves.** The failure is
silent: token count falls, bill rises. Signal: `cacheHitRate` on the new cache-carrying
fixture, compared before and after the eviction stage. This is why the fixture is a
goal and not a nice-to-have — without it this risk has no detector.

**Evicting something that was not actually regenerable.** `resultRecoverable` is a
per-tool assertion, and a wrong `true` destroys information the transcript was the only
record of. Signal: the corpus's response-equality assertions (`runner.ts:329`) fail if
an evicted result changes replay behavior. Residual exposure is a tool that declares
`true` and is exercised only outside the corpus — mitigated by the predicate being a
required, reviewed contract field rather than an easily-stale name whitelist.

**Deferred schemas cause a model to call a tool with malformed arguments** because it
never saw the parameter schema. Signal: `turnsCompleted` falling, and tool-result
equality failing, in the replay gate. This is why the ≤670 token goal alone is not the
gate — the no-regression goal is.

**Reactive compaction masking a real overflow bug.** If `prompt_too_long` handling
silently retries, a genuine context-accounting error looks like a slow session rather
than a failure. Signal: the reactive path is required to be independently testable and
to record that it fired.

## Verification

Against `fixtures/corpus/` via `replayCorpus()`, which is offline and deterministic:

| Metric | Baseline (measured 2026-08-13) | Threshold |
| --- | ---: | ---: |
| Median turn-20 context tokens | **1,117** (752 / 1,117 / 15,272) | **≤670** (≥40% reduction) |
| `long-tool-heavy` turn-20, on its own | 15,272 | **≤3,054** (≥80%) — the eviction-only assertion |
| `systemPromptTokens` | 707 (960 on `long-tool-heavy`) | **below both**, with ≥1 tool deferred |
| `turnsCompleted` + replay equality | all fixtures pass | **unchanged** |
| `cacheHitRate` on `long-tool-heavy` | 0.8569 | **compared pre/post eviction**; a fall indicates prefix invalidation |

**Why ≤670 is a real gate and not an easier one.** Adding `long-tool-heavy` raised the
median from 935 to 1,117, which raises the absolute target from 561 to 670. That is a
weaker-looking number attached to a stronger gate: the old 935 baseline was computed
over two fixtures containing no tool results, where the ≤561 target was unreachable by
eviction under any implementation and demanded a 53% cut of the static prefix from
deferred schemas alone. Passing ≤670 now requires at least two of three fixtures under
the threshold, and the achievable pair is `compacted-session` (needs a modest static
cut) plus `long-tool-heavy` (needs real eviction) — so the gate can only be met by
**both** techniques working, which is what the phase is for.

Named tests:

- `test/replay-runner.test.ts` — existing gate, must stay green unchanged.
- `test/context/eviction.test.ts` (new) — a `read` result is evicted, a `bash` result is
  not; eviction takes the oldest contiguous run, never a middle hole; the on-disk
  session is byte-identical before and after.
- `test/context/deferred-schemas.test.ts` (new) — a deferred tool announces without its
  parameter schema and materializes it on explicit load; `systemPromptTokens` falls.
- `fixtures/__tests__/corpus-hygiene.test.ts` — the new cache fixture must pass the
  existing hygiene gate (no credentials, no personal paths, valid v3 JSONL).

Per AGENTS.md test discipline, each behavior is written test-first and watched fail for
the right reason before implementation.

## Rollout

**Needs `docs/plans/2026-08-13-context-engineering.md`** — two independent mechanisms
(eviction, deferred schemas), a corpus addition, a contract-document transition, and a
roadmap correction, across new and forked files, with a phase gate to verify at the
end. That is more than one sitting and needs its own status tracking.

**Needs an ADR if the cache measurement contradicts the ordering.** The prefix-oldest
eviction decision above is made on structural reasoning because the corpus cannot yet
measure it. If the cache-carrying fixture shows eviction is a net cost, that reverses a
load-bearing design decision and is exactly the "irreversible decision surfacing partway
through implementation" the template says to write an ADR for, cited from here.

**Two corrections land before implementation, not with it:** the roadmap's baseline
figures and `contracts.md` § 2's status. Both are documentation defects found while
grounding this spec, and leaving them in place would mean implementing against a gate
that passes vacuously.
