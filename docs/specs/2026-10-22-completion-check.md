# Spec: A completion check that starts another turn

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-10-22 |
| Last updated | 2026-10-22 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility. No session starts a completion check unless the user sets one. Existing sessions, settings, and verification policies keep their current meaning. `policies.boundary: "post-turn"` still records a result and does not start a turn. |

## Executive summary

Apex Code stops when the model stops. A configured verification command can record a failed exit code. A delegated child can then refuse to report success. Nothing starts another turn from that failure.

This spec adds one active completion condition per session. After a turn ends, the session runs one already-configured verification policy. Exit 0 clears the condition. Any other result starts another turn and gives the model the recorded status. The check is off until the user sets it, and a cap on turns stops the loop.

## Context and motivation

- `docs/research/2026-10-22-coding-agent-cli-gap.md` ranks this first. The research describes Claude Code `/goal` as a session-scoped stop hook judged by a second model. This spec takes the stop-and-continue behavior and uses an existing verification policy as the judge.
- `docs/specs/2026-09-01-configured-verification-and-formatting.md` defines named verification policies, the `explicit` and `post-turn` boundaries, and the five completion statuses.
- `packages/coding-agent/src/core/sdk.ts` `requireVerifiedTurn` fails a delegated child when the tracker is not `verified`. It does not continue the child.
- `docs/adr/0030-configured-command-authority-and-formatter-confinement.md` is the authority model for the command this check runs. This spec does not add a command path.

## Current state

`VerificationTracker` in `packages/coding-agent/src/core/verification-lifecycle.ts` runs one configured policy and stores `verified`, `failed`, or `interrupted`. `AgentSession.requestVerification` is the public call. The `post-turn` boundary changes when the tracker runs. It does not enqueue a prompt.

A delegated child in `packages/coding-agent/src/core/sdk.ts` calls `requireVerifiedTurn` after its run. A status other than `verified` throws, and the delegation ends.

The interactive session already queues a follow-up while a turn is running. Nothing reads a verification record and turns it into that follow-up.

## The problem

A user can pin `npm test` as a verification policy and still watch the model stop while the tests fail. The failure is recorded. The session returns control. The user has to type another prompt to make the model read the failure and try again.

A delegated child is stricter and worse for this job. `requireVerifiedTurn` turns the same failure into an error and ends the child. The child cannot repair the failure it just produced.

## Goals

- [ ] A session has at most one active completion condition, set by the user, naming one configured verification policy id.
- [ ] With no condition set, turn completion is unchanged. No extra command runs.
- [ ] After a turn ends with the condition set, the session runs that policy through `VerificationTracker` and reads the status.
- [ ] Status `verified` clears the condition and does not start another turn.
- [ ] Status `failed` or `interrupted` starts one more turn. The prompt names the policy id, the status, and the exit code or signal from the evidence record.
- [ ] The loop stops after a configured maximum number of continuation turns. The default maximum is 5. The condition clears, and the session reports the cap.
- [ ] The condition clears on an auth failure, an exhausted run budget, and a context overflow that compaction cannot fix. It does not clear on a failed check.
- [ ] Setting the condition does not change the permission mode.
- [ ] A second `set` replaces the active condition. `clear` removes it and does not start a turn.

## Non-goals

- [ ] A second model that reads the transcript and decides whether the condition holds. The research describes that judge. This spec uses a command because the exit code does not depend on the transcript. A model judge is later work.
- [ ] Changing `requireVerifiedTurn` for delegated children. A child that must be verified still fails closed. Continuation is a user-session behavior.
- [ ] Running a command that is not an already-configured verification policy. The check does not accept a shell string.
- [ ] Starting a turn when `policies.boundary` is `post-turn` and no completion condition is set.
- [ ] Changing permission mode, adding a worktree flag, or adding memory. Those are later items in the research note.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Condition | A session-scoped value with `policyId` and `maxTurns`. Not written to settings. | `packages/coding-agent/src/core/completion-condition.ts` |
| Decision | A pure function. Inputs are the tracker status, the evidence record, and the number of continuations already used. Output is `clear`, `continue` with a prompt string, or `stop-at-cap`. | same file |
| Session | After a user turn settles, if a condition is active, call `requestVerification` for its policy id and apply the decision. `continue` queues one follow-up. | `packages/coding-agent/src/core/agent-session.ts` |
| Entry | A slash command `/goal <policy-id>` sets the condition, `/goal` prints it, `/goal clear` removes it. The name matches the research note. The behavior does not match Claude Code's model judge. | `packages/coding-agent/src/core/slash-commands.ts` and the interactive command handler |

The follow-up uses the existing queue. It does not add a second agent loop.

`beforeToolCall` is unchanged. The verification command still goes through the configured-command authority in ADR 0030. The continuation prompt is ordinary user text, so the permission gate applies to whatever the next turn tries to run.

## Deletion inventory

Nothing existing is removed. `post-turn` verification and `requireVerifiedTurn` keep their current behavior. The completion condition is a new session value with no callers today.

## Risks

The loop can spend turns on a check that fails for a reason the model cannot fix, such as a missing executable. The cap is the stop. A test must show that the sixth continuation does not run and that the condition is cleared.

A continuation prompt that includes raw command output could put secrets or unbounded logs into the next turn. The prompt carries the policy id, status, and exit code or signal only. Output stays in the verification artifact.

## Verification

- A unit test for the decision function covers `verified`, `failed`, `interrupted`, a missing policy, and a continuation count equal to the cap.
- A session test sets a condition, returns a failed verification, and asserts one follow-up is queued with the policy id and status.
- A session test with no condition asserts `requestVerification` is not called at turn end.
- A session test at the cap asserts no follow-up and a cleared condition.

No roadmap phase gate applies. This is a product-surface follow-up.

## Rollout

Needs `docs/plans/2026-10-22-completion-check.md`. The work crosses the decision function, the session turn boundary, and the slash command, and each of those should land as its own commit.

No ADR. The command authority and the permission gate are unchanged.
