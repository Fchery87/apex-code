# Run-budget measurements and selected default policy

**Created:** 2026-09-02 · **Status:** Final for TR.3 (spec `2026-09-01-tool-reliability-and-execution-budgets.md`)

This note records the measurements the loop-budget default is selected from
(TR.3) and the policy decisions the implementation (TR.4/TR.5) is held to. The
measurements are reproducible; the commands are stated so the numbers can be
regenerated.

## Method

Two instruments, both offline:

1. **Replay corpus.** `replay()` (packages/coding-agent/src/testing/replay/runner.ts)
   over all nine `fixtures/corpus/*.jsonl` fixtures, run through vitest so every
   package resolves to workspace sources. A replayed assistant message is one
   provider request the loop sent; a replayed tool result is one tool call the
   loop executed. Command:
   `npx vitest --run --silent=false <measurement harness>` (harness was
   temporary; the pinned corpus metrics in `test/replay-runner.test.ts` pin the
   same underlying numbers).

2. **Representative synthetic loops.** `agentLoop` driven by a scripted
   provider: chat-only, a 10-step single-call tool loop, a 5-round × 4-call
   batch loop, steering extension, follow-up extension, and the 10-step loop
   again under simulated provider latency (250 ms and 1000 ms per request,
   20 ms per tool call).

## Results

### Replay corpus (2026-09-02)

| Fixture | User turns | Provider requests | Requests/turn | Tool calls | Tool calls/turn | Wall ms |
| --- | --- | --- | --- | --- | --- | --- |
| branched-session.jsonl | 2 | 2 | 1.0 | 0 | 0.0 | 45 |
| compacted-session.jsonl | 22 | 22 | 1.0 | 0 | 0.0 | 41 |
| error-recovery.jsonl | 2 | 2 | 1.0 | 0 | 0.0 | 8 |
| heavy-tool-output.jsonl | 1 | 2 | 2.0 | 1 | 1.0 | 12 |
| long-multi-turn.jsonl | 22 | 22 | 1.0 | 0 | 0.0 | 40 |
| long-tool-heavy.jsonl | 22 | 32 | 1.5 | 10 | 0.5 | 45 |
| model-switch.jsonl | 2 | 2 | 1.0 | 0 | 0.0 | 5 |
| short-single-turn.jsonl | 1 | 1 | 1.0 | 0 | 0.0 | 6 |
| tool-error-recovery.jsonl | 1 | 3 | 3.0 | 2 | 2.0 | 11 |

Corpus maxima: **3 provider requests** and **2 tool calls** in a single logical
run (`tool-error-recovery.jsonl`).

### Synthetic loops (2026-09-02, scripted provider, no latency)

| Scenario | Requests | Tool calls | Wall ms | Continuations |
| --- | --- | --- | --- | --- |
| chat-only | 1 | 0 | 15 | 0 |
| tool-loop-10 (1 call/request) | 11 | 10 | 31 | 0 |
| batch-4x5 (4 calls/request) | 6 | 20 | 9 | 0 |
| steering-extends (+3) | 4 | 3 | 6 | 1 |
| follow-up-extends (+2) | 3 | 0 | 4 | 2 |

Steering and follow-up extensions ran inside the same logical run, confirming
that continuations are part of one run's request budget rather than separate
runs.

### Simulated provider latency (10-step tool loop)

| Scenario | Requests | Tool calls | Wall time |
| --- | --- | --- | --- |
| 250 ms/request, 20 ms/tool | 11 | 10 | 2,963 ms |
| 1000 ms/request, 20 ms/tool | 11 | 10 | 11,218 ms |

A fully legitimate 10-step loop takes 3–11+ seconds of pure provider latency;
real providers with thinking can be slower still, and the latency distribution
is environment-dependent. Wall time measured offline is compute-bound, not a
latency signal, so no latency-derived wall-time default can be honestly
selected from this environment.

## Counting boundary (stated, not discovered)

- One provider request is counted **when the loop sends one** (at the
  agent-core `streamFunction` boundary), including every request a retry or
  continuation produces. Transparent retries inside the provider layer
  (`retry` settings, 429 backoff) are below this boundary and are not
  separately visible to the loop; they stay bounded by the provider retry
  policy, not by this budget.
- One tool call is counted when the loop **accepts it for execution** — per
  call, whether the batch ran sequentially or concurrently. Batch behavior is
  defined in the spec: calls that have not started when a bound is hit fail
  with a bounded budget-exhausted error instead of executing.
- Wall time starts when the logical run starts and ends when it settles.

## Selected policy

| Decision | Selection |
| --- | --- |
| Default `maxProviderRequests` | **200** per logical run |
| Default `maxToolCalls` | **2000** per logical run |
| Default `maxWallTimeMs` | **No default this release** (unset = unlimited) |
| Continuations | **Share the logical run's budget** — steering, follow-up, AgentSession post-run continuations, and provider-failure retries are the same run; a new run starts at each user prompt |
| Compaction summarization | **Separate named maintenance budget** — a local compaction request does **not** consume `maxProviderRequests`; it is recorded separately (`maintenanceRequests`) on the same controller for observability |
| Unbounded callers | Opt out **per field** with the explicit `"unlimited"` setting value; no implicit unlimited path remains |

Derivation, stated as measurement plus judgment: the heaviest corpus run is 3
requests; the scripted 10-step agentic loop is 11 requests and 10 tool calls;
the batch loop shows 20 tool calls over 5 requests. Real multi-file agentic
turns compound beyond the scripted loop by roughly an order of magnitude. 200
provider requests is ~60× the heaviest corpus run and ~18× the scripted loop;
2000 tool calls is 100 full batches. Both sit far above any measured
legitimate workload and still bound an unattended runaway. This is a judgment
call made **on top of** the measurements above, not a number the measurements
alone imply — which is why the compatibility posture is explicit: any caller
that finds the bound wrong opts out per field with `"unlimited"`.

No wall-time default: latency is environment-dependent (table above), and a
wrong default either kills legitimate slow-provider runs or never fires. The
field ships configurable and unset.

Compaction as a separate maintenance budget: compaction is context
maintenance, not task progress. Counting summarization against the run budget
would push long runs over the limit exactly when they need compaction, and an
exhausted budget that also blocked the compaction request would deadlock into
a context overflow. The requests stay visible through `maintenanceRequests`.
