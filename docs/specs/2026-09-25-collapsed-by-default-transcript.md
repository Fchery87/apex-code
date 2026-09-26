# Spec: A transcript that opens collapsed

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Created | `2026-09-25` |
| Last updated | `2026-09-25` |
| Roadmap phase | `none — product-surface follow-up` |
| Tracking issue/PR | `none` |
| Compatibility posture | `Presentation only, clean break on the default. No session file, setting, CLI flag, or extension API changes shape. A session now opens at overview instead of details. Nothing persists the detail level, so no user has a stored value to migrate.` |

## Summary

A session now opens with everything collapsed. Tool output shows a counted
preview. Edit diffs show their line counts. Thinking shows one
`Thinking... ctrl+o to expand` line. A multi-line error folds to its summary
line. `ctrl+o` opens the transcript one rung at a time, as Prime Agent's
conversation detail cycle does.

## Context

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` already models
  detail as one cycled value, `ChatDetail = "overview" | "details" | "all"`, mapped
  to rendering flags by `chatDetailView()`.
- Prime Agent drives the same three rungs from the same key, and its `overview`
  hides thinking. `docs/research/2026-08-23-prime-agent-tui-reference.md` records its
  tool and thinking collapse behavior.

## Current state

The session opened at `details`. Tool output was collapsed, but every edit diff
and every thinking block rendered in full. `overview` collapsed diffs but left
thinking visible unless the persisted hide-thinking setting was on. A long turn
therefore filled the screen with reasoning the user had not asked to read.

## The problem

The user wants the transcript to read as a list of what happened, with the detail
one key away. Two things prevented that: the starting rung, and an `overview` rung
that did not collapse thinking.

## Goals

- A new session opens at `overview`.
- `overview` collapses thinking whatever the persisted setting says.
- The collapsed thinking line names the key that expands it.
- Showing thinking with `ctrl+t` while at `overview` actually shows it.
- A multi-line error shows one summary line plus the expand hint until `all`.

## Non-goals

- Collapsing assistant answer text. The answer is the thing the user reads.
- Persisting the detail level across sessions. Every session starts collapsed.
- Collapsing one-line errors. There is nothing to fold.

## Proposed solution

`ChatDetailView.revealThinking: boolean` becomes
`thinking: "collapsed" | "preference" | "revealed"`. `overview` collapses,
`details` defers to the persisted setting, `all` reveals. One table decides it, so
`isThinkingHidden()` reads the field instead of combining two booleans.

`INITIAL_CHAT_DETAIL = "overview"` seeds `chatDetail`, and the two expansion
fields derive from `chatDetailView(INITIAL_CHAT_DETAIL)` rather than restating it.

The hidden-thinking label gains the `app.tools.expand` key hint, rendered from the
live binding.

`summarizeError()` in `components/error-summary.ts` picks the folded line: the
first non-empty line, or for a Python traceback the last unindented line, which
names the raised error. It returns undefined for a one-line error. Assistant
message errors, `showError()`, and auto-compaction failures fold through it. The
two chat-level forms reuse `ExpandableText`, so they join the cycle through the
existing `Expandable` walk. `AssistantMessageComponent` gains `setExpanded()`
and is adopted into the current detail level when created. A retry outcome such
as `(gave up after 3 retries)` trails both forms, so it stays visible when folded.
Errors open at `all`, the same rung as tool output, as in Prime.

Turning thinking on with `app.thinking.toggle` at `overview` moves to `details`,
because `overview` would otherwise swallow the request.

## Deletion inventory

- `ChatDetailView.revealThinking`, replaced by `thinking`.
- The "details reproduces pre-cycle behaviour" rationale in the `ChatDetail` doc
  comment, which no longer holds.

## Risks

- Users who liked seeing thinking by default now press `ctrl+o` once per session.
  Mitigation if it proves unpopular: a `chatDetail` setting, as Prime has.

## Verification

- `test/chat-detail.test.ts` pins the rung table and the initial rung.
- `test/interactive-mode-status.test.ts` covers thinking at each rung and the
  `ctrl+t` escape from `overview`.
- `test/assistant-message.test.ts` asserts the collapsed line reads
  `Thinking... ctrl+o to expand` and hides the reasoning, and that a multi-line
  error folds until `setExpanded(true)` while a one-line error is left alone.
- `test/error-summary.test.ts` pins the summary rule.
- `test/suite/regressions/retry-collapses-to-one-error.test.ts` keeps the retry
  outcome on the folded line.

## Rollout

Ships in the next release. Recorded under `[Unreleased]` in
`packages/coding-agent/CHANGELOG.md`.
