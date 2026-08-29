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
`commit-tree`, `update-ref`, `for-each-ref`) over an async `spawn` with a timeout. Async
rather than `spawnSync` because capture runs at turn start, where a synchronous `add -A`
on a large worktree would block the event loop and stall the TUI.

## Task table

| Task | Unit | Status | Commit |
| --- | --- | --- | --- |
| CP.1 | C1 | Done | `17edae3c6` |
| CP.2 | C1 | Done | `17edae3c6` |
| CP.3 | C1 | Done | `17edae3c6` |
| CP.4 | C2 | Done | `aef71d3a9` |
| CP.5 | C3 | Done, partly verified — see below | `fe81da383` |
| CP.6 | C4 | Done | `fe81da383` |
| CP.7 | C1 | Done | `ca9bae79f` |
| CP.8 | C1, C3 | Done | `pending` |

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

`core/checkpoints/git-checkpoints.ts`. Public surface: `createGitCheckpoints` returning
`undefined` outside a repository, and `capture`, `lookup`, `list`, `restore`, `prune` on
the value it returns. No barrel: the one consumer imports the module directly, and an
`index.ts` re-exporting a single file earns nothing.

The registry is git refs, never a process-local map. That is the choice the spec's § The
problem exists to justify, and it is what a reviewer should check first.

**Done when:** every case from CP.2 passes and `npx tsgo --noEmit` is clean.

### CP.4: The settings key

`checkpoints?: CheckpointSettings` on `Settings`, with `enabled?: boolean` and
`maxPerSession?: number`. Absent by default.

**Done when:** the key type-checks and an unset key constructs no engine.

### CP.5: Session wiring

Capture at turn start keyed to the current leaf entry. `checkpointSettings` reaches the
session the way `mcpRuntime` and `lspOperations` already do, and the session resolves the
engine lazily because `createGitCheckpoints` is async and session construction is not.

Restore does **not** move into core. The prompt belongs at the `session_before_fork` seam
that already exists for it, and pushing a `ui.select` into `AgentSession` would put a
terminal decision inside a layer that runs headless. CP.6 covers it instead.

A delegated child deliberately does not capture: it shares the parent's cwd, so it would
interleave refs under its own session id into the same repository, and the parent's
per-turn capture already covers what the child does inside that turn.

**Done when:** a session with the key set writes a ref, and a session without it writes
none.

**Verified:** `test/checkpoints/session-wiring.test.ts` drives the real
`createAgentSession` path and asserts both, keyed to the session manager's own id.
Mutation-checked by removing the `sdk.ts` passthrough, which fails two of its three cases.

**Not verified:** the `turn_start` call site in `agent-session.ts` itself. Asserting it
needs a driven turn against a live model, which this suite does not do. The call is two
lines and the layer beneath it is covered.

### CP.6: Example and documentation

`examples/extensions/git-checkpoint.ts` is rewritten, not deleted. CP.5 took over capture,
so the example is now restore only, and it resolves its own engine from the workspace
rather than being handed one. That works because the registry is git, which is the same
property that makes a checkpoint survive a restart.

The engine is exported from the package index so an extension can reach it.
`docs/user-guide.md` documents the setting, the ref namespace, and the removal command.

**Done when:** the spec's deletion inventory is settled and `npm run check` is green.

### CP.7: Ignore the machine's line-ending preference

Added after `windows-latest` failed on PR #50. `core.autocrlf` is `true` by default on
Windows, so capture normalised an agent-written LF file and restore wrote it back as CRLF.
The restore was silently rewriting line endings across the worktree, which contradicts this
plan's own goal of a byte-exact round trip.

Every checkpoint invocation now runs with `-c core.autocrlf=false`, applied in `runGit` so a
future command cannot forget it. `.gitattributes` is left alone on purpose: that is the
repository's policy rather than the machine's, git applies it to every checkout, and
overriding it would make a restore disagree with `git checkout` on the same files.

**Done when:** a repository with `core.autocrlf=true` round-trips both an LF file and a CRLF
file unchanged.

**Verified:** the new case in `test/checkpoints/git-checkpoints.test.ts` reproduces the
failure on Linux by setting the config in the fixture repository. Running the file under
`GIT_CONFIG_GLOBAL` pointed at a config with `autocrlf = true` reproduces CI exactly: three
failures without the fix, including the same two cases `windows-latest` named, and fifteen
passes with it.

### CP.8: Act on the automated review of PR #50

Four comments, all four legitimate on inspection, three of them real defects. Recorded
because two contradicted comments this branch had already written, which is the useful
signal.

**Capture raced the turn it precedes.** `turn_start` fired the snapshot detached, so a tool
call could edit the worktree while `add -A` was still walking it and the ref would hold
mid-turn state. "The state before the model acted" is the entire guarantee, so the capture
is now awaited. The engine's timeout bounds the wait and a failed capture stays non-fatal.

**`nextOrdinal` did not compute a maximum.** It concatenated two independently sorted lists
and read the tail, which is not the largest element. A restore early in a session left the
pre-restore namespace holding a lower ordinal than later checkpoints, so two captures reused
one number and `bound` pruned by a broken order. Now a real maximum across both namespaces.

**A failed pre-restore pin did not stop the restore.** `update-ref` was issued and its result
ignored, so an unpinned snapshot stayed unreachable and collectable while the worktree was
overwritten anyway, losing the state the pin exists to preserve. Checked now, and the restore
returns before touching the worktree.

The fourth was a missing fence language in `docs/user-guide.md`, fixed as reported.

**Done when:** the ordinal collision has a regression case and the suite is green.

**Verified:** the new case reproduces the collision (four refs, three distinct ordinals) and
is mutation-checked by restoring the old tail read, which fails it. 28 checkpoint tests pass.
The pre-restore pin failure is guarded but not covered by a case: forcing `update-ref` to
fail needs filesystem-level injection that would not resemble the real failure.
