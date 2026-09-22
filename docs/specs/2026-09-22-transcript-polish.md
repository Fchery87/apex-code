# Spec: One look per role in the transcript

**Status:** Active

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Created | `2026-09-22` |
| Last updated | `2026-09-22` |
| Roadmap phase | `none — product-surface follow-up` |
| Tracking issue/PR | `none` |
| Compatibility posture | `Presentation only. No session file, setting, CLI flag, or extension API changes shape. An extension renderer that hides its body no longer gets a generic expand hint appended; it states its own, as the built-ins do.` |

## Summary

The transcript is the surface a user reads every turn, and three things in it
contradict themselves. A user message and an assistant answer wear the same rail.
A retried request prints one error per attempt. A tool panel states its duration
twice and offers to expand output it has already shown in full. This change gives
each role one look, collapses a retry into one line, and routes every counted
"lines hidden" hint through one function.

## Context

- `docs/specs/2026-08-25-ember-tui-surface.md` introduced the tool lifecycle spine.
- `docs/specs/2026-09-07-ember-workflow-completion.md` made disclosure per call and
  set the frame budget this change must stay inside.
- Commit `410369ceb` gave assistant text the same accent spine as user messages.
  Commit `b337513f7` then moved the spine into the only padding column, which left
  `│hello` with no gap, to keep a transformer test's 78-column width.
- `packages/tui` is a dependency (ADR 0001). Nothing here touches it.

## The problem

Observed in a live session at 120 and 64 columns on `v0.4.0`.

**Roles.** The user's prompt and the assistant's final answer both render
`│text` in ember at column 0. The only difference is `userMessageBg` `#111113`,
one step off the terminal ground. The assistant rail also appears only when a
message has no tool calls, so one role has two looks.

**Retry.** A provider returning `service_unavailable` three times produced four
stacked `Error:` lines inside the message rail, then a fifth, differently worded
error outside it at another indent. The session already drops each retried
attempt from agent state; the chat kept every one.

**Tool panels.**

- bash prints `✓ done 43ms` in the header and `Took 0.0s` in the body. The two
  disagree, and the header already ticks live while running.
- `write` of a two-line file shows both lines and then `ctrl+o to expand`. The
  component guessed that a body without the phrase "to expand" must hide something.
- `ls -la` hid one of six lines behind a hint that costs the same row.
- "1 earlier lines". Twelve call sites write the counted hint by hand in five
  shapes.

## Design

**Roles.** A user message keeps the ember spine and its background, with one blank
column between spine and text. `Box` padding becomes `max(outputPad, 2)` when
padding is on, so the spine takes the first column and the gap is the second.
Assistant text carries no rail at any time. Tool panels keep their lifecycle
spine. Three roles, three looks, none conditional. `message-spine.ts` has one
caller left and is inlined into `user-message.ts`.

**Retry.** A retried attempt is superseded, so its component leaves the chat when
`auto_retry_start` arrives, mirroring the session dropping it from agent state.
The live retry indicator already carries the attempt count. On
`auto_retry_end` with `success: false`, the last attempt's component is also
removed and exactly one error line remains, naming the provider's error and how
the retry ended. A cancelled retry keeps the last provider error rather than the
bare word "cancelled".

**Disclosure.** `formatHiddenLines(count, position)` in `keybinding-hints.ts` is
the one shape: `... (N more lines, ctrl+o to expand)`, with `earlier` for a tail
preview and `all` for a body collapsed to nothing. It is singular at one and empty
at zero. `previewLineCount(total, limit)` returns `total` when hiding would leave
a single line behind a hint, since the hint costs that row. Every counted call
site uses both.

The component-owned hint is deleted. It guessed that a body without the phrase
"to expand" must be hiding something, which is false for every renderer that shows
its body in full, and the component cannot know what a renderer hides. A renderer
that hides states it. `read` collapses to `... (N lines, ctrl+o to expand)`, except
a compact read, whose call row already names the key. `delegate` collapses the same
way. Extension renderers that hide their body now own their hint, as the built-ins do.

`ToolPanelComponent` owns the one blank row between header and body. Renderers
written before the panel open their body with their own blank rows, which stacked
to two. The panel drops a body's leading blank rows and inserts exactly one.

bash's `Took` / `Elapsed` row is deleted. The header owns duration.

## Acceptance criteria

- [x] A user message renders `│ hello` at `outputPad` 1, never wider than its width.
- [x] Assistant text renders without `│`, with or without tool calls.
- [x] Three retried failures leave exactly one `Error:` line in the chat.
- [x] A cancelled retry leaves one line naming the last provider error.
- [x] A two-line `write`, a one-line bash result, and a two-line error show no
      expand hint.
- [x] Every tool panel has exactly one blank row between header and body.
- [x] A six-line result under a five-line preview shows all six lines.
- [x] A single hidden line reads "1 more line"; none of the counted hints is
      hand-written.
- [x] bash output has no `Took` or `Elapsed` row.

## Verification

- Focused suites: `test/user-message.test.ts`, `test/assistant-message.test.ts`,
  `test/tool-execution-component.test.ts`, `test/disclosure-hint.test.ts`,
  `test/suite/regressions/retry-collapses-to-one-error.test.ts`.
- `npx tsgo --noEmit`, then `npm test`.
- Live session in tmux at 120 columns: a prompt, a bash call, a write, and a
  forced retry against an unavailable provider.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `components/message-spine.ts` | module | Inlined into `user-message.ts`, its only remaining caller. |
| Accent rail on assistant text | behavior | Deleted. Assistant text has no rail. |
| One `Error:` line per retried attempt | behavior | Deleted. The superseded attempt leaves the chat. |
| `Retry failed after N attempts:` line beside the last attempt's error | behavior | Replaced by one line. |
| bash `Took` / `Elapsed` row and its `startedAt` / `endedAt` plumbing | behavior, code | Deleted. The header owns duration. |
| Twelve hand-written counted hints | code | Replaced by `formatHiddenLines`. |
| `renderDisclosureHint` and its "to expand" phrase match | code | Deleted. Each renderer states what it hides. |
| `fallbackHidNothing`, `EXPAND_HINT_LABEL` | code | Deleted with it. |
| A generic expand hint under extension renderers that hide their body | behavior | Deleted. The renderer owns it, like the built-ins. |
| `BashRenderState`, bash's one-second render interval, `formatDuration` | code | Deleted. They existed only for the `Took` row. |
| The second blank row under a tool header | behavior | Deleted. The panel inserts exactly one. |
| `delegate`'s collapsed `explore · 12 lines` summary | copy | Replaced by the shared counted hint; the header already names the agent. |
