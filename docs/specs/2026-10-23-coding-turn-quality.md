# Spec: Coding-turn quality

**Status:** Active

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-10-23 |
| Last updated | 2026-10-23 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility. No session, setting, or tool call changes meaning until the slice that owns it lands. Recovery continuations are bounded and fire only on the stop reasons named below. The todo gate is off until a session has a todo list. `/goal`, `edit`, and `delegate` keep their current behavior until their own slices say otherwise. |

## Executive summary

Apex Code stops when the model stops, and its todo list is a notepad. A truncated reply, an empty reply after tool results, and a completed todo list with no recorded check all return control to the user. This spec orders the eleven slices that close that gap. Recovery and the todo gate come first, because a better prompt on a loop that stops early still stops early.

The order was set by reading Apex Code's loop, tools, and settings, then reading Jcode's turn loop, response recovery, todo policy, and edit hints. Jcode is MIT. This spec records behavior. It does not copy Jcode's source, types, or prompt text.

## Context and motivation

- `packages/agent/src/agent-loop.ts` already refuses tool calls on a `length` stop and stops after three identical failed tool calls. It does not continue an empty post-tool reply, a length stop that produced no tool call, or tool markup that arrived as prose.
- `docs/specs/2026-10-22-completion-check.md` starts another turn only when the user has set `/goal` to a configured verification policy. Delegated children still fail closed in `requireVerifiedTurn` and cannot repair the failure.
- `packages/coding-agent/src/core/model-runtime.ts` implements `streamSimpleForRole`. Production turns do not call it. Compaction uses the session model.
- `packages/coding-agent/src/core/system-prompt.ts` asks the model to read before editing and to verify before reporting done. It does not state a search, change, and check procedure.
- `packages/coding-agent/src/core/tools/edit-diff.ts` returns advisory closest matches. Fuzzy match does not ignore leading whitespace. There is no multi-file patch apply.
- `docs/research/2026-08-08-harness-comparative-review.md` is the channel for behavior observed elsewhere. Jcode was read from its MIT tree on 2026-10-23: `crates/jcode-app-core/src/agent/turn_loops.rs`, `crates/jcode-app-core/src/agent/response_recovery.rs`, `crates/jcode-todo-policy/src/lib.rs`, and `crates/jcode-app-core/src/tool/edit.rs`.

## Current state

A fresh session has no verification policies. The tracker boundary defaults to `explicit`. `getDelegationMaxDepth()` defaults to 2. `write` refuses an existing file the session has not read. `edit` refuses only when the file changed since the read. `--worktree` changes the process cwd into the new tree. A path in the parent checkout is outside that cwd, so it asks. It is not denied. Bash confinement is off unless the user settings file sets it, and the helper bind is read-only on `/` plus a writable cwd and no network.

## The problem

The model can end a turn with no visible answer after tools ran, or with a todo list marked complete and no command output to show for it. The user has to type the next prompt. That is the failure this order exists to remove. Later slices (roles, prompt, patch apply, specialists) raise the quality of the turns that do continue. They do not help a turn that has already stopped.

## Goals

- [ ] The eleven slices below land in the numbered order. A later slice does not start until the slice before it has a failing test that went green for the right reason.
- [ ] Each slice is its own spec or its own section in the plan, with its own commits. This document is the order, not the design of every slice.
- [ ] Nothing in this order adds a tool whose job is calendar, mail, desktop control, or rewriting Apex Code's own binary.

## Non-goals

- [ ] Copying Jcode's system prompt. "Be maximally helpful and persist" is not a coding procedure.
- [ ] A second model that judges whether the task is done. The judge is a command exit code or a recorded check on the todo list.
- [ ] Restoring the boundary removed by ADR 0032.
- [ ] A shared-checkout swarm that notifies peers when a file shifts. Parallel work stays on worktrees until a later spec names the notice.
- [ ] Self-modification of the Apex Code binary.
- [ ] Changing the meaning of `/goal` for a session that already set one.

## Proposed solution

Land in this order.

| # | Slice | What changes | Done when |
| --- | --- | --- | --- |
| 1 | Response recovery | After a turn with no tool call, continue on a length or truncation stop (cap 3), on an empty reply whose prior message is a tool result (cap 5), and once when the text contains an unparsed tool-call shape. Truncated tool calls stay refused. Three identical failures still stop the loop. | A test for each cap shows the next continuation does not run. A normal `end_turn` with text does not continue. |
| 2 | Todo completion gate | When every todo is completed, the session does not end unless each item has a recorded check: the command or observation, and the result. A missing check, or a completion claimed with no prior evidence, queues one more turn. The prompt tells the model to update the list and not to address the user yet. | A session test with a completed list and no checks queues one follow-up. A list with checks does not. A session with no todos is unchanged. |
| 3 | Default verification continue | If the project has a verification policy and the turn mutated files, run that policy once before the model may stop, using the `/goal` decision already in `completion-condition.ts`. A failed status queues one repair turn, under the existing cap. A delegated `general` child uses the same continue-on-failure instead of throwing from `requireVerifiedTurn`. | A mutating turn with a failing policy queues one follow-up. A read-only turn does not run the policy. A child with a failing policy gets one repair turn. |
| 4 | Live model roles | Compaction summaries and the continuation text in slices 1–3 use the `tiny` role when it resolves. Plan mode uses the `plan` role when it resolves. The coding turn stays on the session model. A missing role is the session model, not an error. | A test with a fake role map shows the summary request carries the tiny model. A config with no roles is unchanged. |
| 5 | Coding procedure | Replace the one-line identity with a short procedure: search before reading whole files, read before edit, smallest change that satisfies the failure, run the check, report the real output, stop when the check is green or say why it cannot be. Keep the existing safety rules. | The static prefix stays inside the enforced token budget. A prompt test asserts the procedure is present and the safety rules remain. |
| 6 | Edit hints and patch apply | On an exact miss, if the lines match after trim, name the line and say the whitespace differs. Do not apply the trimmed text. Add `apply_patch` for one unified diff across files, exact hunks only, through the same path permission and evidence path as `edit`. | A miss caused by indentation returns the line number and does not write. A two-file diff applies both or neither. |
| 7 | Specialist agents | Add `debugger` (read, grep, find, ls, bash, no write) and `verifier` (read plus test). Each has a procedure in its definition. `general` still cannot delegate. The capability ceiling is unchanged. | A child definition that names `write` under `debugger` is refused. `general` still has no `delegate`. |
| 8 | Compaction diff | After the narrative summary, append `git diff --stat` for the workspace and the last failing command with its exit code, when the session has them. The summary model must not be the only copy of those facts. | A compaction fixture with a known diff contains the stat and the exit code in the stored summary. |
| 9 | Parent-checkout deny | A session started with `--worktree` denies `edit`, `write`, and git commands whose target resolves in the parent checkout. Ask is not enough. | A write to the parent path is a denial with no prompt. A write inside the worktree is unchanged. |
| 10 | Split the session object | Move completion checks, verification follow-ups, and delegation resume out of `packages/coding-agent/src/core/agent-session.ts` before more behavior lands there. No behavior change in this slice. | The moved functions have the same tests, and the session file no longer owns those three concerns. |
| 11 | Prompt-prefix check | Re-measure the production static prefix after slices 5–7. Raise the enforced budget only by the measured delta, recorded in this spec. | `test/context/static-prefix.test.ts` is green at the new number, and the number is written here. |

Slice 1 uses `prepareNextTurn` or the existing follow-up queue. It does not add a second agent loop. Slices 2 and 3 share that queue with `/goal`. A turn that already has a `/goal` condition does not gain a second continuation from the todo gate in the same stop.

`beforeToolCall` is unchanged. Patch apply and the parent-checkout deny go through the existing path permission spec. Evidence for `apply_patch` uses the `diff` kind `edit` already emits.

## Deletion inventory

Nothing is removed by this document. Slice 10 moves code and deletes the old copies in the same change. Slice 5 replaces the identity sentence. Both deletions are recorded in those slices' own notes when they land.

## Risks

A recovery continuation that fires on a normal finished turn burns a provider request and can undo a deliberate stop. The caps and the `end_turn` exclusion are the stop. A test must show a finished answer does not continue.

The todo gate can loop on a check the model cannot produce. One continuation, then stop, is the bound. It is not the `/goal` cap of 5.

Routing compaction to `tiny` can drop a path the coding model needed. Slice 8 pastes the diff and the exit code so the summary model is not the source of those facts.

## Verification

- Slice 1: unit tests on the decision function, plus one session test per continuation kind.
- Slice 2: session test with and without recorded checks.
- Slice 3: session test and one delegated-child test.
- Slice 4: fake provider test that records the model id on the summary request.
- Slices 5 and 11: the existing static-prefix test.
- Slice 6: edit-diff tests for the hint, and an apply-patch test that a failed second file leaves the first unchanged.
- Slice 7: delegation ceiling test.
- Slice 8: compaction fixture.
- Slice 9: path permission test with a worktree cwd and a parent target.
- Slice 10: the existing session tests, no new behavior.

No roadmap phase gate applies. This is a product-surface follow-up.

## Rollout

Needs `docs/plans/2026-10-23-coding-turn-quality.md` before implementation, because the slices are sequential and each one should land as its own commits. No ADR yet. An ADR is required only if slice 4 changes which model a stored session replays as, or if slice 9 adds a permission behavior the rule model cannot express.
