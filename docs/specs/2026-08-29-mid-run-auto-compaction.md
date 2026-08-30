# Spec: Mid-run auto-compaction

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-08-29 |
| Last updated | 2026-08-30 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | [upstream Pi issue #6879](https://github.com/earendil-works/pi/issues/6879) |
| Compatibility posture | Preserves compatibility. Existing settings, session files, extension events, and final-response compaction keep their current shape. The only behavior change is that an over-threshold tool loop pauses at a completed tool-batch boundary, compacts, and resumes before sending another oversized provider request. |

## Executive summary

Apex Code currently evaluates the auto-compaction threshold only after an entire agent run ends. A single long tool-calling run can therefore grow past `contextWindow - reserveTokens` and continue making provider requests until overflow. Check the same threshold after completed tool batches, stop the low-level run at that safe boundary, compact through the existing session path, and resume only after compaction succeeds.

## Context and motivation

- `docs/specs/2026-08-13-context-engineering.md` records threshold and overflow compaction as inherited Pi behavior.
- `packages/coding-agent/docs/compaction.md` promises automatic compaction at `contextWindow - reserveTokens`.
- Public upstream Pi issue [#6879](https://github.com/earendil-works/pi/issues/6879) independently records the same run-boundary gap. This is licensed public project evidence, not an unlicensed source.
- ADR 0003 applies because this changes forked `pi-agent-core` and `pi-coding-agent` files. The implementation must remain a narrow, legible upstream diff.

## Current state

`AgentSession._checkCompaction()` implements the threshold correctly, but its live calls are after `agent.prompt()`/`agent.continue()` return and before a new idle user prompt. The agent-core loop can execute many assistant/tool batches before returning. It already exposes `shouldStopAfterTurn`, but `AgentSession` does not use it for compaction and the hook does not state whether the loop has another provider turn pending.

Overflow recovery still works because a provider error ends the low-level run. This makes the defect appear as late compaction rather than no compaction in short sessions.

## The problem

During one user prompt, an assistant can repeatedly call tools. Once a completed tool result pushes the next request over the configured threshold, Apex Code sends that request anyway because no threshold check runs at that boundary. On models whose backend accepts more context than Apex Code declares, the footer can exceed 100% before provider overflow finally activates reactive compaction. On stricter backends, useful work can stop at overflow.

The existing tests cover the private threshold calculation and provider-overflow recovery. They do not assert that threshold compaction occurs before the next provider request in a real multi-turn tool run.

## Goals

- [x] A public `AgentSession.prompt()` regression proves threshold compaction occurs after a completed tool batch and before the next provider request. (`test/suite/regressions/6879-mid-run-auto-compaction.test.ts`, landed on main at `61be67e27`)
- [x] Successful mid-run compaction resumes the unfinished tool-driven run without a new user prompt.
- [x] Failed or impossible mid-run compaction does not send the same known-over-threshold next request.
- [x] Existing final-response threshold compaction, overflow recovery, queues, and host stop hooks retain their behavior.

## Non-goals

- [ ] Do not redesign `reserveTokens` to account for model `maxTokens`; that is a separate output-reservation budget problem.
- [ ] Do not redesign compaction cut-point geometry for branches dominated by oversized trailing tool results; that requires its own preparation contract.
- [ ] Do not compact during tool execution. The safe boundary is after the full tool batch and its persisted results.
- [ ] Do not copy or inspect any unlicensed implementation. This design uses the existing Apex/Pi public hooks and public issue evidence only.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Turn-stop context | Expose whether the completed turn would otherwise lead to another provider request. | `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts` |
| Session threshold hook | Compose with the host `shouldStopAfterTurn` hook. Estimate context after completed tool results and request a graceful stop when the next provider turn would cross the configured threshold. | `packages/coding-agent/src/core/agent-session.ts` |
| Post-run continuation | When the stop was requested for compaction, run the existing automatic threshold compaction path and continue only on success. | `packages/coding-agent/src/core/agent-session.ts` |
| Regression coverage | Drive a real prompt, tool call, large tool result, compaction extension, and resumed provider request. Assert event order at the provider boundary. | `packages/coding-agent/test/suite/regressions/6879-mid-run-auto-compaction.test.ts` |
| User docs | State that threshold checks occur between completed tool turns. | `packages/coding-agent/docs/compaction.md` |

The existing `shouldStopAfterTurn` seam stays authoritative: a previously installed host hook runs first. Compaction only adds a stop when the host did not already stop the run and another provider request is pending. Tool execution and persistence finish before the check, so tool-call/result ordering remains intact.

## Deletion inventory

Nothing existing is removed — this is an additive lifecycle check that reuses the current compaction format, events, and settings.

## Risks

- A terminating tool could be resumed accidentally. The loop must explicitly report whether it would continue, and the session must gate on that signal.
- A failed compaction could allow another oversized request. The post-run path must return no continuation when compaction fails.
- A composed host stop hook could be overridden. A focused test must prove an existing `shouldStopAfterTurn` result wins.
- An overly eager estimate could compact short runs. Below-threshold and final assistant turns must remain covered by existing tests.

## Verification

1. Run the new regression before implementation and observe that the next provider request starts before any `compaction_start` event.
2. Run it after implementation and assert compaction precedes that request and the final assistant response completes.
3. Run the narrow agent-core and coding-agent compaction suites.
4. Run `npx tsgo --noEmit`.
5. Run `npm test` at the end of the implementation slice.

## Rollout

Small enough to implement directly, with no separate plan doc. The behavior is guarded by the existing `compaction.enabled` setting and needs no session migration or staged rollout.
