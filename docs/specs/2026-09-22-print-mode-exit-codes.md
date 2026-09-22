# Spec: the non-interactive exit contract

**Status:** Active

## Metadata

| Field | Value |
| --- | --- |
| Author | Fchery87 |
| Created | 2026-09-22 |
| Last updated | 2026-09-22 |
| Roadmap phase | none — product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | **Clean break for `--mode json` exit codes, additive everywhere else.** A `--mode json` run that failed exits `1` where it previously exited `0`. That is a break in the literal sense, and it is the right posture because the old value was a defect rather than a contract: it reported success for provider errors, aborted turns, and exhausted budgets, so no caller could have depended on it deliberately. Callers who scripted around it did so by parsing the event stream, which keeps working unchanged. The `result` event is additive to a stream whose consumers already tolerate unknown event types. `--mode text` is unchanged on every path a run actually takes, but see the second amendment: two edge cases move, both toward the stop reason the loop decided. |

## Executive summary

`--mode json` exits `0` when the run failed. The exit-code logic sits inside a branch that
only text mode reaches, so provider errors, aborted turns, and exhausted run budgets all
report success to the caller. This spec moves the exit-code decision out of that branch,
gives the non-interactive path a named status vocabulary, and emits that status as a final
`result` event so a JSON consumer can read the cause rather than infer it from an integer.

## Context and motivation

- `docs/research/2026-09-22-antigravity-cli-comparison.md` § 4 records the defect and the
  measurement behind it. This spec acts on that record and on the first architectural row
  of its § 5.
- `docs/adr/0004-permission-rule-model.md` establishes that a non-interactive session
  refuses to start rather than degrading silently, because "an agent that burns a full run
  discovering it cannot write anything" produces denials that look like a bug. The defect
  here is the same failure at the other end of the run, and the fix restores the posture
  that ADR already chose.
- `docs/adr/0035-default-bash-timeout.md` is the precedent for deriving a runtime default
  from recorded suite behavior rather than inventing one, and is why this spec declines to
  invent a numeric taxonomy in § Non-goals.

No prior spec covers the non-interactive exit contract. `packages/coding-agent/docs/json.md`
documents the event stream and is silent on exit codes.

## Current state

`packages/coding-agent/src/modes/print-mode.ts` is shared by `--print` and `--mode json`.

- Line 36 initialises `let exitCode = 0`.
- Line 129 writes the session header to stdout when `mode === "json"`.
- Line 147 opens `if (mode === "text")`.
- Lines 154 and 163, both inside that branch, are the only assignments of `exitCode = 1`.
  They cover `lastStopReason.kind === "budget-exhausted"` and an assistant `stopReason` of
  `"error"` or `"aborted"`.
- Line 175 returns `exitCode`.
- Lines 57 to 70 install signal handlers exiting `143` on `SIGTERM` and `129` on `SIGHUP`
  outside Windows.
- Lines 180 to 182 catch an uncaught error and return `1`.

So a JSON-mode run reaches line 175 with `exitCode` still `0` on every failure that does
not throw.

This is Apex Code's own code, not inherited upstream behavior: `--mode json` and the budget
stop reason are both post-fork additions, so ADR 0003's merge cost does not apply.

`README.md:480` recommends `apex-code --mode json --permission-mode plan --print` under the
line "Use JSON/RPC when another process owns orchestration".

Test coverage at `packages/coding-agent/test/print-mode.test.ts` asserts the error path at
`:126` and the budget path at `:143`, both with `mode: "text"`. The JSON case at `:111`
asserts only that a successful run returns `0`.

## The problem

A CI job following the README cannot tell a failed run from a successful one.

Reproduction: run `apex-code --mode json --permission-mode dontAsk --print` against a
provider configured with an invalid key. The stream carries an assistant message whose
`stopReason` is `"error"`, the process exits `0`, and `$?` reports success. The same holds
when a run budget is exhausted, which is the case an operator is most likely to hit
deliberately.

The cost compounds because the JSON stream is the documented integration path. Every
pipeline built against it inherits a success signal that means nothing, and each one has to
discover the defect independently and write its own stream-parsing workaround. Those
workarounds then become the compatibility obligation.

## Goals

- [x] A `--mode json` run whose assistant settles with `stopReason` `"error"` or
      `"aborted"` exits `1`, asserted by a test that fails against the current code.
- [x] A `--mode json` run stopped by `budget-exhausted` exits `1`, asserted by a test that
      fails against the current code.
- [x] A successful `--mode json` run still exits `0`, and every existing `--mode text`
      assertion in `test/print-mode.test.ts` passes unchanged.
- [x] The final line of a `--mode json` run is a `result` event carrying a `status` field
      drawn from the vocabulary in Proposed solution, asserted for one success case and one
      failure case.
- [x] `packages/coding-agent/docs/json.md` states the exit codes and the `status`
      vocabulary, and `README.md`'s machine-readable section links it.

## Non-goals

- [ ] **A numeric exit-code taxonomy beyond `0` and `1`.** Antigravity documents distinct
      codes per malformed-input class. Apex Code already uses `0`/`1` on this path plus
      `143`/`129` for signals and `0`/`1`/`2` for `auth check`, and inventing codes `2`
      through `7` now would freeze a mapping chosen from no evidence. The cause belongs in
      the `status` field, which is extensible without a compatibility event. Revisit only
      when a real caller needs a distinction the stream cannot express.
- [ ] **`--json-schema` structured output.** It is a parameter on the result envelope this
      spec introduces, and adding both at once would conflate a defect fix with a feature.
      It gets its own spec once this envelope exists.
- [ ] **`--print-timeout`.** Unrelated to the exit contract, and ADR 0035 already governs
      the timeout that matters.
- [ ] **Changing `--mode rpc` or `--mode acp`.** Both own their own lifecycle and neither
      routes through `runPrintMode`. Touching them here would widen the diff past the
      defect.
- [ ] **Changing `--mode text` behavior.** It is correct today on every path a run actually
      takes, and the existing tests are the regression guard for those. This non-goal was
      written as "byte identical" and the second amendment records where that turned out to
      be too strong.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Exit decision | Compute the outcome once, before the `mode === "text"` branch, and assign `exitCode` from it regardless of mode | `src/modes/print-mode.ts` |
| Status vocabulary | `AgentStopReason["kind"]`, aliased as `PrintRunStatus`, so the envelope cannot drift from the loop's own outcome type | `src/modes/print-mode.ts` |
| Text rendering | Keep the existing stdout and stderr writes inside the text branch, now reading the computed outcome instead of recomputing it | `src/modes/print-mode.ts` |
| `result` event | In JSON mode only, write one final line `{"type":"result","status":…}` after the stream settles and before returning | `src/modes/print-mode.ts` |
| Tests | Re-run the error and budget cases with `mode: "json"`, and assert the `result` line in both a success and a failure case | `test/print-mode.test.ts` |
| Docs | State the exit codes and the `status` vocabulary | `packages/coding-agent/docs/json.md`, `README.md` |

The outcome is computed from two values already in scope at line 147, `lastStopReason` and
the final assistant message, so no new state threads through the function. This matters
because the laziness protocol's test applies directly: the defect is a misplaced brace, and
the fix should read as one.

`status` is deliberately a string rather than an integer so it can gain members without a
compatibility event. `"completed"` is emitted explicitly rather than inferred from the
absence of a failure, so a truncated stream is distinguishable from a clean one. See the
amendment below, which replaced this section's original `"success"` with the agent loop's
own vocabulary.

This touches no seam named in `docs/architecture/overview.md`. `beforeToolCall`,
`ruleContent`, `transformContext`, and evidence capture are all upstream of the point where
`runPrintMode` decides what to return, and none of them observe the exit code.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| The `exitCode = 1` assignments at `src/modes/print-mode.ts:154` and `:163` in their current position | code | superseded by a single mode-independent outcome computation above the text branch |
| The implicit contract that `--mode json` exits `0` on failure | behavior | removed; it was never written down and never intended |
| `test/print-mode.test.ts:111`'s standing as the only JSON-mode assertion | doc | superseded by the JSON error, budget, and `result` cases added alongside it |

| Text mode's dependence on the last message when `agent_end` disagrees | behavior | removed; the stop reason now decides for both modes, which moves the two edge cases in the second amendment |

The signal handlers, the session header line, and every existing event in the stream are
unchanged. Text mode's observable behavior is unchanged on every path a run actually takes,
and the second amendment records the two edge cases where it is not.

## Amendment — 2026-09-22, during implementation

Two things the design got wrong, found by reading the types rather than by testing.

**The status vocabulary is `AgentStopReason["kind"]`, not a new one.** This spec proposed
`success | error | aborted | budget-exhausted`. `packages/agent/src/types.ts:177` already
defines `AgentStopReason` as `completed | aborted | error | budget-exhausted`, carried on
`agent_end`, with its precedence documented in the type's own docstring. Inventing `success`
alongside an existing `completed` would have created two vocabularies for one concept and a
mapping between them to keep correct. The envelope uses the loop's type directly, exported as
`PrintRunStatus`.

**The outcome resolves from the stop reason first, not from the message.** This spec described
deriving the outcome from a mix of the stop reason and the settled assistant message. The stop
reason is the authoritative source, because the loop already applied its precedence to produce
it; the message is only a fallback for runs where no `agent_end` reaches print mode. A test
pins that fallback, because removing it silently returns `0` for a message-only error.

Neither changes the exit codes, the compatibility posture, or the deletion inventory.

## Amendment — 2026-09-22, after independent verification

This spec claimed `--mode text` was byte identical. An independent verifier on pull request
#142 disproved it, and the claim is corrected above rather than defended.

Two text-mode edge cases move, both because the stop reason now decides instead of the last
message. Read against the base at `9a62c26d1`, where every text-mode failure path sat behind
`if (lastMessage?.role === "assistant")`.

1. **`agent_end` reports `error` or `aborted` and the last message is not an assistant
   message.** The old guard failed, nothing ran, and the process exited `0`. It now exits
   `1`. Reachable in principle, because auto-compaction reassigns `agent.state.messages`
   (`core/agent-session.ts:3009`).
2. **`agent_end` reports `completed` and a stale assistant message still carries an error.**
   The old code exited `1` on the message. It now exits `0`, which is the correction commit
   `adaefe83c` made deliberately after review, applied to both modes rather than only JSON.

Both are the same improvement as the defect this spec fixes, pointed at text mode. Neither
was intended when the non-goal was written, which is why the non-goal was wrong rather than
the code.

The verifier also found that `SIGTERM` drops the entire JSON stream, not only the `result`
envelope, at both commits. That is pre-existing and out of scope here; `json.md` should not
imply a partial stream arrives.

## Risks

**A consumer depends on the current exit code.** Something may treat `0` from `--mode json`
as "the process ran" rather than "the run succeeded", and will start seeing `1`. The signal
is a CI job that begins failing on runs it previously passed, which is the correct outcome
surfacing rather than a regression. Named in the compatibility posture so it is not a
surprise, and listed in the changelog entry this change carries.

**The `result` event is mistaken for an `AgentSessionEvent`.** It is written by the print
path, not emitted by the session, so a consumer that exhaustively switches on session event
types will meet an unknown `type`. Mitigated by documenting it in `json.md` as a
print-mode-only envelope rather than adding it to `AgentSessionEvent`, which would put a
transport concern into the session type.

**The fix silently under-covers a fourth failure mode.** Stop reasons beyond `error`,
`aborted`, and `budget-exhausted` may exist or be added. The signal is a JSON run that exits
`0` with a `status` the test matrix does not name, so the tests assert on the vocabulary
exhaustively rather than case by case.

## Verification

- `npx vitest run test/print-mode.test.ts` from `packages/coding-agent`, showing the two new
  JSON failure assertions red against the current tree before the fix and green after. The
  red run is the evidence that they test the defect rather than the implementation.
- `npm test` at the root once the slice is complete.
- `npx tsgo --noEmit` for the `result` event's type.
- `npm run check` for the docs lifecycle gate and lint.
- No replay-corpus measurement applies. This serves no roadmap phase gate, changes no
  context accounting, and touches no token budget, so there is no metric or threshold from
  `docs/roadmap.md` to measure against.

## Rollout

Small enough to implement directly, no separate plan doc. One source file, one test file,
two documentation files, and a changelog entry.

No ADR is needed. The two decisions inside it, keeping the exit codes at `0`/`1` and putting
the cause in a string status, are both reversible: adding numeric codes later is additive,
and the status vocabulary is designed to gain members. Neither is contested and neither is
irreversible, which is the bar `AGENTS.md` sets for an ADR.
