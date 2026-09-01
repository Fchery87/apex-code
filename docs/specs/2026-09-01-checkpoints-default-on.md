# Spec: Checkpoints on by default

**Status:** Active

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-09-01 |
| Last updated | 2026-09-01 |
| Roadmap phase | none (boundary-gap follow-up; see `docs/research/2026-08-31-harness-landscape.md`) |
| Tracking issue/PR | none |
| Compatibility posture | Deliberate behavior change for sessions that configure nothing (see below) |

**Compatibility posture:** this is a default flip, and it is a behavior change
on purpose: sessions that never wrote a `checkpoints` key start capturing
worktree checkpoints in git repositories. Nothing is removed, no session
format changes, the prompt prefix is untouched (checkpoints are not tools),
and the explicit opt-out (`checkpoints: { enabled: false }`) is the only
setting a user needs to know. The audit's framing stands: rewind is the
feature that makes an autonomous agent safe to let run, and a first-run user
will not find a settings key that does not exist.

## Executive summary

The landed git-checkpoints subsystem constructs nothing unless a
`checkpoints` settings key is present, so out of the box there is no rewind.
The default flips: absent key means **on** inside a git repository, `{ enabled:
false }` opts out, and a workspace that is not a repository remains a
supported no-op (the engine's existing lazy `git rev-parse` probe resolves to
undefined, swallowed, at the first capture attempt only).

## Context and motivation

- `docs/research/2026-08-31-harness-landscape.md` § 5 — audit recommendation:
  checkpoints default-on, "the one feature that makes an autonomous agent
  safe to let run"; peers ship rewind on by default.
- `docs/specs/2026-08-28-git-checkpoints.md` and ADR-backed engine behavior:
  dedicated ref namespace (`refs/apex-code/checkpoints/...`), fixed identity,
  pre-restore pinning, per-session pruning, EOL pinning — all landed and
  verified.
- The engine was built default-shy while the repository was proving itself
  ("an unconfigured session runs no `git` subprocess"). That caution expired
  with three-OS CI green on the engine and its wiring.

## Current state

- `core/checkpoints/session-checkpoints.ts:30` — `const enabled =
  options.settings?.enabled === true;` — the entire default, in one line.
- `core/checkpoints/git-checkpoints.ts:117-119` — non-repo workspaces resolve
  to `undefined` through a lazy `git rev-parse --git-dir` probe; errors are
  swallowed by design ("a supported state rather than an error").
- `core/agent-session.ts:994` — capture is invoked from the turn path;
  construction is synchronous and lazy resolution means the first capture
  attempt pays the probe.
- `test/checkpoints/session-checkpoints.test.ts` pins the current default
  ("writes no ref and runs no git when the setting is absent");
  `test/checkpoints/session-wiring.test.ts` pins the SDK path the same way.
- `core/settings-manager.ts` documents "Absent by default; an absent key
  constructs no engine."

## The problem

A first-run user gets no rewind, will not find a settings key they do not
know exists, and the safety asymmetry is backwards: the users most likely to
let the agent run autonomously are the least likely to have configured
checkpoints before something goes wrong.

## Goals

- [ ] With no `checkpoints` key, capture succeeds in a git repository and
  writes to the existing `refs/apex-code/checkpoints/<sessionId>/...`
  namespace; nothing else about the engine changes.
- [ ] `checkpoints: { enabled: false }` constructs an inert engine: no refs,
  no `git` subprocess, identical to today's absent behavior.
- [ ] Outside a git repository the default-on engine stays inert: capture
  resolves to `undefined`, nothing throws into a turn, and the only cost is
  the single lazy probe per session.
- [ ] `getCheckpointSettings()` accessor semantics are unchanged (absent key
  still reads as `undefined`); the default lives at the engine, not the
  accessor.
- [ ] The settings schema documentation and the session/SDK wiring comments
  describe the new default and the opt-out.

## Non-goals

- [ ] The LSP default question (the audit flags it as the same *kind* of
    decision; it is a separate change with its own cost model).
- [ ] Cross-session or cross-restart checkpoint durability beyond the landed
    ref namespace, SQLite/daemon integration, and any restore UX beyond the
    landed `restore` path.
- [ ] A first-run interactive notice. The TUI hint system exists
    (`FirstUseHints`), but a checkpoints hint is only meaningful alongside
    restore UX guidance; deferring keeps this slice a pure default flip. The
    settings schema comment is the documentation of record for now.
- [ ] Changing `maxPerSession`, the ref namespace, identity pinning, or any
    engine behavior landed with the git-checkpoints spec.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Default | `options.settings?.enabled === true` becomes `options.settings?.enabled !== false`, with the rationale comment | `core/checkpoints/session-checkpoints.ts` |
| Schema docs | The `checkpoints` key's doc comment describes default-on and the opt-out | `core/settings-manager.ts` |
| Tests | Flip the two "absent means nothing" pins to default-on pins (unit + SDK wiring); add an explicit-disabled wiring pin | `test/checkpoints/session-checkpoints.test.ts`, `test/checkpoints/session-wiring.test.ts` |

The engine, ref namespace, pruning, identity, timeout, and restore behavior
are untouched. A workspace that is not a repository keeps its supported
no-subsystem state; the probe runs once per session at the first capture
attempt, is timeout-bounded, and its failure is the no-op.

## Deletion inventory

Nothing is removed — a default inverts. The sentence "an absent key constructs
no engine" is deleted from `core/settings-manager.ts` and superseded by the
new default; the tests that pinned the old default are rewritten, not deleted.

## Risks

- **Users who did not ask for checkpoints now get refs written.** That is the
  intended change; the refs live in a dedicated namespace, never touch the
  user's branches or worktree, are pruned per session, and `git` never sees
  them as part of the repository's history. The explicit opt-out is one line.
- **CI checkouts and fresh clones.** Both were explicitly designed for
  (pinned identity, no user config needed); the engine requires only that the
  workspace be a repository.
- **Non-repo workspaces pay one probe.** One timeout-bounded `git rev-parse`
  per session at the first capture attempt, result swallowed. Accepted.

## Verification

- `test/checkpoints/session-checkpoints.test.ts`: absent key captures in a
  repository; `{ enabled: false }` stays fully inert; non-repo stays
  no-throw/no-ref; engine reuse and pruning unchanged.
- `test/checkpoints/session-wiring.test.ts`: the SDK path captures by default
  and stays inert when explicitly disabled.
- `test/checkpoints/checkpoint-settings.test.ts` must still pass unchanged
  (accessor semantics preserved).
- Full `npm test` as the closing gate; three-OS CI before landing.

## Rollout

Small enough to implement directly — a one-line default, two comment blocks,
and test updates — so no separate plan doc beyond the task table. Lands only
after three-OS CI.
