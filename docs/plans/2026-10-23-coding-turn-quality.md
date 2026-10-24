# Plan: Coding-turn quality

**Status:** Active

Spec: `docs/specs/2026-10-23-coding-turn-quality.md`. Local tests named below passed. Nothing in this plan is committed, so no SHA is recorded.

| Slice | State | What landed |
| --- | --- | --- |
| 1 Response recovery | local tests green | Empty post-tool reply (cap 5) and one markup nudge. Length stays on compact-and-retry. |
| 2 Todo completion gate | local tests green | Optional `check`. One continuation when every item is done without one. |
| 3 Verification continue | typecheck green | Mutating turn runs the first policy once. `general` gets one repair before the existing throw. |
| 4 Live model roles | local tests green | Compaction uses `tiny`. Plan mode sends the `plan` role on the request and does not record a model change. A missing role stays on the session model. |
| 5 Coding procedure | prefix test green | Procedure sentence. Budget still 4,580. |
| 6 Edit hints and patch | local tests green | Indent miss names the line and does not write. `apply_patch` is all-or-nothing and registered. |
| 7 Specialist agents | builtin test green | `debugger` and `verifier`. |
| 8 Compaction diff | facts test green | `compactionFacts` appends `git diff --stat`. A failed bash, powershell, or test command is remembered and included. |
| 9 Parent-checkout deny | wired | `--worktree` passes the parent into the session. `edit`, `write`, and `apply_patch` deny a path inside that parent and outside the worktree. |
| 11 Prompt-prefix check | green after apply_patch | `static-prefix.test.ts` passed at the existing 4,580 budget with `apply_patch` registered. |
| 10 Session split | partial | `recoveryForTurn` now owns the recovery decision. The session method only queues the follow-up. Delegation handles stay in `agent-session.ts` because moving them would change ownership of live children. |
