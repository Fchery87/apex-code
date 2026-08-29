**Status:** Active

# Git-backed session checkpoints implementation plan

**Goal:** A user who enables `checkpoints` gets a durable snapshot of the worktree at each
turn, pinned under `refs/apex-code/checkpoints/`, restorable exactly when they fork back to
an earlier entry. A session with `checkpoints` unset runs no `git` subprocess and writes no
ref.

**Spec:** `docs/specs/2026-08-28-git-checkpoints.md`

**Architecture:** Four units, ordered so the engine and its settings key land before
anything calls them. C1 is pure plumbing over `git` with no session, UI, or settings
involvement, so it is testable against a scratch repository with no harness running. C2 is
schema only. C3 is the first unit that changes a running session's behaviour. C4 settles
the spec's deletion inventory.

**Tech stack:** TypeScript, Vitest, `git` plumbing (`read-tree`, `write-tree`,
`commit-tree`, `update-ref`, `for-each-ref`) over `spawnSync`.

## Task table

| Task | Unit | Status | Commit |
| --- | --- | --- | --- |
| CP.1 | C1 | Done | `pending` |
| CP.2 | C1 | Done | `pending` |
| CP.3 | C1 | Done | `pending` |
| CP.4 | C2 | Not started | — |
| CP.5 | C3 | Not started | — |
| CP.6 | C4 | Not started | — |

Order is load-bearing in one place. CP.4 must land before CP.5, because the settings key is
what decides whether the engine is constructed at all, and wiring a capture that no setting
can disable would make every session pay for the feature.

Everything through CP.4 is inert. No task from CP.1 through CP.4 changes what any existing
session does, so each can land on its own.

### CP.1: Prove the git mechanics before writing the engine

The whole feature rests on four plumbing invocations behaving as assumed. Settle them
against a real repository first, because a wrong assumption here invalidates the engine's
entire shape rather than one function.

Checked: a temp-index `add -A` captures untracked files, honours `.gitignore`, and leaves
the real index and worktree byte-identical; `commit-tree` needs `-p HEAD` omitted in a
repository with no commits; `read-tree -u --reset` seeded from the current worktree removes
files created after the checkpoint; ignored files survive a restore untouched.

**Done when:** the recipe is recorded in the spec's § Proposed solution as the exact
command sequence, not as prose.

### CP.2: The failing test

Write `test/checkpoints/git-checkpoints.test.ts` against the engine's intended public
surface before the engine exists. Run it, watch it fail to import, then fail on behaviour.

Every goal in the spec maps to a case here. The cases that matter most are the four that
correspond to the example's defects: survives `git gc --prune=now`, survives a second
engine instance, captures untracked files, and removes a file created after the checkpoint.

**Done when:** the file exists, runs, and fails for the right reason.

### CP.3: The engine

`core/checkpoints/git-checkpoints.ts` plus a barrel. Public surface: `createGitCheckpoints`
returning `undefined` outside a repository, and `capture`, `lookup`, `list`, `restore`,
`prune` on the value it returns.

The registry is git refs, never a process-local map. That is the choice the spec's § The
problem exists to justify, and it is what a reviewer should check first.

**Done when:** every case from CP.2 passes and `npx tsgo --noEmit` is clean.

### CP.4: The settings key

`checkpoints?: CheckpointSettings` on `Settings`, with `enabled?: boolean` and
`maxPerSession?: number`. Absent by default.

**Done when:** the key type-checks and an unset key constructs no engine.

### CP.5: Session wiring

Capture at turn start keyed to the current leaf entry. Offer restore when a fork targets an
entry that has a checkpoint.

**Done when:** a session with the key set writes a ref per turn, and a session without it
writes none.

### CP.6: Example and documentation

Rewrite `examples/extensions/git-checkpoint.ts` onto the engine, or delete it if CP.5 makes
it redundant. Document the setting, the ref namespace, and the one-line removal command in
`docs/user-guide.md`.

**Done when:** the spec's deletion inventory is settled and `npm run check` is green.
