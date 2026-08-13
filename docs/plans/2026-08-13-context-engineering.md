# Phase 3 context engineering

**Status:** Active

Implement tool-result eviction and deferred tool schemas so a large tool surface and
long sessions stay affordable. This plan implements
`docs/specs/2026-08-13-context-engineering.md` and the now-settled context pipeline
order (`docs/architecture/contracts.md` § 2) in dependency order; each task must be
verified before it is marked done.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 3.1 Eviction core — a pure `evictToolResults(messages, contract lookup, budget)` that replaces the oldest contiguous run of recoverable tool results with markers | Done | `75e7bb61e` | New `test/context/eviction.test.ts`: a `read` result is evicted; a `bash` result (`resultRecoverable: false`) is preserved; eviction takes an oldest-contiguous run and never punches a middle hole; repeat runs are byte-identical |
| 3.2 Deferred-schema core — announce-by-name projection plus an explicit load path | Done | `3ab596a25` | New `test/context/deferred-schemas.test.ts`: a `deferSchema: true` tool announces without its parameter schema; an explicit load materializes the real one; the static prefix measurably shrinks |
| 3.3 Wire the three stages at the `transformContext` seam in the settled order | Done | `2045f7e86` | New `test/context/wiring.test.ts`: order asserted end to end via a real `AgentSession` against a faux stream function (deferred-schema stub and eviction marker both present in the same outbound request; an already-evicted result is not reprocessed on a later request); the on-disk session is byte-identical before and after an eviction pass (the Phase 7 constraint, checked as file-prefix equality across turns). `npx tsgo --noEmit` clean at repo root; `packages/coding-agent`'s own `npm run build` (`tsgo -p tsconfig.build.json`) clean — the root `npm run build` was not run in full since it rebuilds all eight packages and only `coding-agent` changed |
| 3.4 Reactive compaction on provider `prompt_too_long`, distinct from the threshold path | Done — already existed, pre-fork (`a38e61909`) | `73fe2c817` | New `test/context/reactive-compaction.test.ts`: a provider overflow error compacts with `reason: "overflow"` while `reserveTokens` sits at its default (so the threshold path cannot be the one firing); `compaction_end` records that it fired. No production code changed — see the spec's "Current state" correction |
| 3.5 Phase gate verification against the replay corpus | Not started | — | Median turn-20 **≤670**; `long-tool-heavy` **≤3,054** on its own; `systemPromptTokens` below 707 (and below 960 on `long-tool-heavy`); `turnsCompleted` and replay equality unchanged across all nine fixtures |
| 3.6 Cache measurement and the ordering decision | Not started | — | `cacheHitRate` on `long-tool-heavy` compared pre/post eviction; if prefix-oldest eviction is contradicted, an ADR lands **before** the phase closes |

## Groundwork already done

Three pieces of this phase landed while grounding the spec, because each was a
precondition for the gate meaning anything. They are recorded here rather than as plan
tasks, since they are already verified and pushed:

- **`fixtures/corpus/long-tool-heavy.jsonl`** (`280616593`) — the two pre-existing
  turn-20 fixtures contain zero tool calls and zero tool results, so the gate was
  structurally blind to eviction, and every fixture recorded `cacheRead`/`cacheWrite`
  of 0, so `cacheHitRate` was a constant zero. Verified against
  `npm run test:scrubber` (21 tests) and `test/replay-runner.test.ts` (16 tests).
- **The corrected Phase 3 baseline** (`51de6098d`) — the roadmap's cited "1,563
  (1,745 / 1,380)" does not reproduce and made the gate vacuous.
- **`contracts.md` § 2 settled** (`51de6098d`) — all four ordering questions answered.

## Why this order

3.1 and 3.2 are pure functions with no dependency on each other, so either can go
first; 3.1 is listed first because eviction is the larger lever and its shape
constrains 3.3's wiring more than deferred schemas do. 3.3 depends on both. 3.5 depends
on everything before it, because the gate is measured on the assembled pipeline, not on
either stage alone. 3.6 depends on 3.5 having run at least once, since the cache
comparison needs a post-eviction measurement to compare against.

3.4 is independent of the eviction and schema work and could run at any point; it is
placed late because it is the smallest item and the one least likely to affect the
gate.

## The gate math, and why both techniques must work

Baseline (measured 2026-08-13, `replayCorpus()`): 752 / 1,117 / 15,272, median
**1,117**. Target ≤670 means at least two of three fixtures must land under the
threshold.

- `compacted-session` is 707 static + 45 message tokens. Only a static cut moves it —
  eviction has nothing to act on. Needs `systemPromptTokens` ≤ 625.
- `long-tool-heavy` is 960 static + ~14,312 message tokens. Only eviction moves it
  meaningfully; deferred schemas can cut at most ~6% of it.
- `long-multi-turn` is 707 + 410, with no tool results. Reaching ≤670 would need a 63%
  static cut, which is the hardest of the three and is not the expected path.

So the achievable pair is `compacted-session` + `long-tool-heavy`, and it requires
deferred schemas **and** eviction to both work. Neither alone passes.

The separate ≥80% assertion on `long-tool-heavy` (task 3.5) exists because the median
under-credits eviction: the heavy fixture is the outlier, so the median can improve
while eviction does nothing at all. Deferred schemas cannot reach ≥80% on that fixture,
so only working eviction passes it.

## Merge cost

`core/context/eviction.ts` and `core/context/deferred-schemas.ts` are new, Apex-only
files and cost nothing against ADR 0003's ceiling. Task 3.3 touches
`core/agent-session.ts`, which is forked from Pi, so its diff stays as small as the
wiring allows — the stages themselves live in the new files, and `agent-session.ts`
gains calls, not logic. Task 3.4 touches the same forked file at the existing
`isContextOverflow` seam (`agent-session.ts:2032`) for the same reason. Pi's compaction
(`core/compaction/`) is deliberately not rewritten; eviction is a stage placed around
it.

## The ADR trigger

The prefix-oldest eviction decision in `contracts.md` § 2 was made on structural
reasoning, because the corpus could not measure cache behavior at the time. It can now
(`cacheHitRate` 0.8569 on `long-tool-heavy`). If task 3.6's pre/post comparison shows
prefix-oldest eviction is a net cost, that reverses a load-bearing decision recorded in
a settled contract, and it gets its own ADR before this phase closes — not a quiet
redesign and not a note in this plan.

## Not in this plan

Per the spec's Non-goals: no on-demand schema *search* tool (Phase 4's problem), no MCP
deferral defaults, no time-based eviction, no rewrite of Pi's compaction, and no
re-recording of the pre-existing corpus fixtures. `long-tool-heavy.jsonl` was an
addition, taken before implementation and recorded in the corpus README; the two
existing turn-20 fixtures are byte-untouched.

## Test discipline

Every task is test-first per AGENTS.md: write the failing test, run it, confirm it
fails for the right reason, then implement. Tests must `chdir` to a scratch directory
rather than writing into the repo's own state. The corpus is offline and deterministic
and must stay that way — no test in this phase may introduce a clock, a network call,
or a random value into the replay path.
