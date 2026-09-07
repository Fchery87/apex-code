# Spec: The permission prompt shows what it is authorizing

**Status:** Draft

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Created | `2026-09-07` |
| Last updated | `2026-09-07` |
| Roadmap phase | `none — product-surface follow-up` |
| Tracking issue/PR | `pull request #90 delivers the request shape this builds on` |
| Compatibility posture | `Preserves compatibility. Additive only.` |

**Compatibility posture.** Every change is additive. `PermissionAskRequest` gains an
optional field, `ExtensionUIDialogOptions` gains an optional field, and the tool contract
gains an optional producer. A tool with no producer, a host that ignores the new dialog
option, and an existing extension responder all keep their current behavior. Nothing on
disk changes shape.

## Executive summary

The permission prompt names a rule, not a change. Approving an edit reads
`Permission required — edit: edit paths matching "exact:/repo/src/auth.ts"`, which is the
grammar the gate will write rather than the lines that will move. A diff is already on
screen, drawn while the tool call streamed, but it was computed by re-reading the
pathname and nothing ties it to the operation the gate authorized. This spec puts a
preview into the prompt, produced from the prepared operation, and states plainly which
tools can and cannot offer one.

## Context and motivation

- `docs/specs/2026-09-07-ember-workflow-completion.md` deferred this and records why. It
  delivered the honest scope and the denial guidance that this builds on.
- `docs/adr/0029-prepared-path-operation.md` is the governing decision. Authorization and
  execution share one prepared operation, and execution checks device and inode identity
  rather than the pathname.
- `docs/adr/0010` keeps rule authorship with the tool. Display text never generates
  permission grammar, and a preview is display text.
- `docs/roadmap.md` § Explicitly not building rules out a second TUI stack, which is why
  the prompt is still a selector rather than a bespoke review screen.

## Current state

**A diff already exists, and it is earlier than the prompt.** `interactive-mode.ts:3507`
creates a `ToolExecutionComponent` on `message_update`, as soon as a `toolCall` block
appears in the streaming assistant message. `edit.ts:465` then calls `computeEditsDiff`
from `renderCall`, so the proposed diff renders in the transcript before the agent loop
reaches `beforeToolCall` at `agent-loop.ts:668`.

**That diff is not tied to the authorized target.** `computeEditsDiff` at
`edit-diff.ts:767` takes a pathname, calls `resolveToCwd`, then `access` and `readFile`.
It is a second, independent resolution of the same user-supplied string, which is exactly
what ADR 0029 removed from the authorization and execution pair.

**The preview also runs before the operation exists.** `prepareCall` is invoked by
`evaluateToolCall` in `gate.ts`, which runs inside `beforeToolCall`. At streaming time
there is no `PreparedPathOperation` to read through, so the existing preview could not
use one even if it wanted to.

**Only `edit` has any preview at all.** `write` replaces a whole file and `bash` runs a
command, and neither renders a proposal before approval.

**The prompt itself carries only the rule.** `gate.ts` builds its description from
`spec.describe(ruleForCall)`, so the user reads a path glob.

## The problem

A user approving an edit is shown a rule, and separately, further up the transcript, a
diff that nothing guarantees is the same file. Three failures follow.

The prompt does not answer its own question. "Allow edit paths matching
`exact:/repo/src/auth.ts`" tells the user which grammar gets written, not which lines
change.

The visible diff can be of a different file than the one that will be written. Replace
the path with a symlink after the streaming preview and before approval, and the diff on
screen describes the old target while the gate authorizes and ADR 0029 pins the new one.
The write is safe. The consent is not.

`write` and `bash` ask for approval with no proposal at all, which is where a blind yes
is most costly.

## Goals

- [ ] The prompt shows the change it is authorizing, not only the rule that would persist.
- [ ] Any diff shown at approval time is read through the `PreparedPathOperation` the gate
      validated, so it cannot describe a different file from the one that will be written.
- [ ] `write` shows the content it would replace, and `bash` shows the exact command.
- [ ] A tool with no producer, and a file the producer cannot read, both degrade to a
      truthful summary rather than to silence or to a fabricated diff.
- [ ] The preview never executes the tool, never writes, and never grants authority the
      gate did not already validate.
- [ ] `pi-tui` and `pi-ai` are unchanged, and no second TUI stack appears.

## Non-goals

- [ ] **No new authorization mechanism.** The preview reads through the prepared value and
      changes no decision. `docs/specs/2026-09-07-ember-workflow-completion.md` already
      records why a preview fingerprint is not built: a replaced file fails ADR 0029's
      identity check and an edited file fails the edit tool's own `old_string` match.
- [ ] **No bespoke review screen.** The design reference draws the permission prompt as
      the same selector shape as the model picker, and the roadmap rules out a second TUI
      stack. The prompt stays a selector that gains a preamble.
- [ ] **The streaming preview is not removed.** It is useful while the call arrives and
      costs nothing when no gate is configured. It is relabelled as a proposal rather than
      promoted to the authoritative one.
- [ ] **No preview for a tool that cannot describe itself cheaply.** A producer that would
      have to run the tool to know its effect does not get one.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Request shape | `PermissionAskRequest` gains `preview?: PermissionPreview`, a discriminated union over `diff`, `summary`, and `unavailable`. | `core/permissions/responder.ts` |
| Producer seam | `PermissionSpec` gains an optional `previewCall(params)` returning a `PermissionPreview`. Called by the gate only after it has decided to ask. | `core/tools/contract.ts`, `core/permissions/gate.ts` |
| Edit producer | Reads through `getPreparedPathOperation(params)` and `readPreparedPath`, then reuses the existing diff calculation on that content. | `core/tools/edit.ts`, `core/tools/edit-diff.ts` |
| Write producer | Summarises the replacement, with byte counts and the first changed line. | `core/tools/write.ts` |
| Bash producer | Returns the exact command string as a summary. | `core/tools/bash.ts` |
| Prompt surface | `ExtensionSelectorComponent` gains an optional `preamble` component rendered under the title, above the rows. | `components/extension-selector.ts`, `core/extensions/types.ts` |
| Responder | Renders the preview into the preamble and passes it through `select`'s existing options argument. | `core/permissions/responder.ts` |

**The producer runs once, after the decision to ask.** `evaluateToolCall` already calls
`prepareCall` before resolving, so the prepared operation exists by the time the `ask`
branch is reached. The producer is invoked there and nowhere else, so an allowed or denied
call never pays for it.

**Reading through the prepared operation is what makes the preview honest.**
`computeEditsDiff` is left in place for the streaming proposal, and a second entry point
takes content rather than a path. The producer supplies content from `readPreparedPath`,
which opens the final component `O_NOFOLLOW` and compares device and inode against the
identity recorded at decision time. A swapped target therefore fails the preview the same
way it fails the write, and the prompt says so instead of drawing a diff of the old file.

**Bounded, always.** A preview is capped in lines and bytes before it reaches the request.
Binary content, a file above the cap, and a missing producer all resolve to
`{ kind: "unavailable", reason }`, which the prompt renders as one honest line.

**The selector keeps its shape.** The preamble is a `Component` the responder builds, so
diff colouring stays in Apex-owned code and `pi-tui` gains nothing. The prompt remains a
list of choices with a keybinding footer, which is what the design reference asks for.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| Nothing | code | Nothing existing is removed. |

This change is additive. The one thing it could have deleted, the pathname-based
`computeEditsDiff`, is deliberately retained: it still serves the streaming proposal,
which runs before any prepared operation exists and therefore has nothing safer to use.
Removing it would leave the transcript with no preview at all while a call arrives, which
is a worse experience for no security gain, because that render authorizes nothing.

## Risks

**The producer reads a file the user then declines.** Showing a diff requires reading, and
the gate is deciding about a write. The read happens in process, is shown only to the
person deciding, and never reaches the model. It is also the read the gate has already
validated a target for. The signal that this is wrong would be a preview appearing for a
tool whose contract does not name a path, which the producer seam makes impossible because
only a path spec can supply one.

**A preview adds latency to every ask.** The prompt now waits on a read. The mitigation is
the byte cap and that the producer runs only on the ask branch. The signal is an approval
prompt that visibly lags the tool call, and the check is a test asserting the producer is
not called on an allowed or denied resolution.

**Two previews disagree on screen.** The streaming proposal and the prompt preview can
differ when the file changed between them, which is precisely the case worth surfacing.
The prompt's preview wins and says it is the authorized one. The signal is a user report
of two diffs, and the test drives a concurrent replace between stream and approval.

**The preamble breaks narrow terminals.** The selector currently sizes to its title and
rows. The check is a rendered-width assertion at 120, 80, 56, 40, and 28 columns with a
long diff, matching the ladder tests the footer already carries.

## Verification

Test-first, per `AGENTS.md`.

- Producer. Extend `test/permissions/` with an edit preview read through a prepared
  operation, a target replaced by a symlink between preparation and preview, a binary
  file, a file above the cap, and a tool with no producer. Assert the unavailable reason
  in each degraded case rather than an empty diff.
- No new authority. Assert the producer never executes the tool, and that a denied call
  produces no evidence record.
- Ordering. Assert `previewCall` is not invoked when the resolution is allow or deny.
- Surface. Extend `test/extension-selector-search.test.ts` with a preamble at 120, 80, 56,
  40, and 28 columns, asserting every line stays within width.
- Live. Drive the real TUI through a gated edit, a gated write, and a gated bash, and read
  the prompt.
- Gates. `npx tsgo --noEmit`, the narrowest relevant test file first, `npm test` once per
  slice, and `npm run check` before close.
- Frame budget. The producer runs once per ask rather than per frame, so the benchmark
  does not reach it. Record that rather than a number, per the gate in `AGENTS.md`.

## Rollout

Small enough to implement directly, with no separate plan document. The producer seam,
the three producers, and the preamble are one slice each, and each ends in a test.

An ADR is not written up front. If the producer's read turns out to need a capability the
tool contract does not already grant, that is a change to the security boundary rather
than to presentation, and it earns an ADR at that point and is cited here.
