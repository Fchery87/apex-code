# Spec: Git-backed session checkpoints

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Status | `Active` |
| Created | `2026-08-28` |
| Last updated | `2026-08-28` |
| Roadmap phase | `none — product-surface follow-up` |
| Tracking issue/PR | branch `feat/git-checkpoints` |
| Compatibility posture | Preserves compatibility. Nothing that works today stops working. The engine is a new module with no existing callers, the settings key is absent by default and inert when unset, and no session, ref, or CLI behaviour changes for a user who configures nothing. The one deliberate coupling is that a checkpoint is written into the workspace's own `.git` under a namespaced ref prefix, which is additive to a repository and removable with one `git for-each-ref --format='%(refname)' 'refs/apex-code/**' \| xargs -r -n1 git update-ref -d`. Session format v3 is untouched: checkpoints are keyed by entry id but stored outside the session file, so a session written with this feature on still loads in a build without it. |

## Executive summary

`examples/extensions/git-checkpoint.ts` demonstrates restoring code state when the user
forks a session, and its mechanism cannot survive contact with a real session. This spec
replaces that mechanism with a core engine that snapshots the worktree into a real commit
object pinned under `refs/apex-code/checkpoints/`, captures untracked files, never touches
the user's index, HEAD, branch, or stash, and restores exactly. The engine is opt-in
through a new `checkpoints` settings key and adds no tool, so the static prompt prefix is
unchanged.

## Context and motivation

- `docs/adr/0010-one-canonical-tool-contract.md` — the reason this ships as a service
  rather than a `git` tool. A tool would need capabilities, permission grammar, context
  behaviour, and evidence emission, and would duplicate `bash`, which already runs git.
- `docs/specs/2026-08-28-sandbox-delegation-and-escalation.md` — U1 landed
  `core/sandbox/git-identity.ts`, which projects a synthesized `user.name` and
  `user.email` into the sandboxed child. That is what makes git usable inside a session at
  all, and it is the prerequisite this builds on.
- `docs/roadmap.md` § "Explicitly not building" — the list this change must not
  contradict. Checkpoints are not on it.
- `packages/coding-agent/examples/extensions/git-checkpoint.ts` — the 53-line prior art
  this supersedes, and the source of the three defects in § The problem.

## Current state

- `examples/extensions/git-checkpoint.ts:11` holds checkpoints in a
  `Map<string, string>` local to the extension closure. Nothing is persisted.
- `:21` captures with `git stash create`, which writes a **dangling** commit. It is
  reachable from no ref, so `git gc` and every command that triggers auto-gc may reap it.
- `:49` clears the whole map on `agent_settled`, so a checkpoint never outlives the agent
  run that made it.
- `git stash create` records tracked modifications only. Untracked files are absent from
  the snapshot, and it produces empty output on a clean tree.
- `:43` restores with `git stash apply`, which merges the snapshot into the current
  worktree. Files created after the checkpoint survive it, so the result is not the
  checkpointed state.
- `core/slash-commands.ts:23,35,36` register `/tree`, `/fork`, and `/clone`. Conversation
  rewind is shipped and works. Only file-state rewind is missing.
- `core/agent-session-runtime.ts:150` emits `session_before_fork`, gated on
  `runner.hasHandlers`, so a session with no handler pays nothing.

None of the above is forked Pi behaviour that Apex has left alone; the example is Apex's
own, so ADR 0003 merge cost does not apply.

## The problem

**1. A checkpoint does not survive a restart.** The map is in memory. A user who quits
and resumes has no checkpoints for any entry in the resumed session, while `/tree` and
`/fork` still offer to navigate to those entries. The offer and the capability disagree.

**2. A checkpoint can be garbage collected while the session is still running.** `git
stash create` produces an unreferenced commit. Any `git` command may trigger auto-gc, and
the agent runs `git` through `bash` constantly. The failure is silent and arrives as
`fatal: bad object` at restore time, after the user has already answered "yes, restore".

**3. A restore does not restore.** `git stash apply` leaves files created after the
checkpoint in place and cannot bring back a file the checkpoint had and the worktree has
since deleted. A user who accepts the prompt gets a third state that never existed.

**4. Untracked files are not captured at all.** The common shape of agent work is creating
new files. `git stash create` omits them, so the most likely thing a user wants reverted
is the one thing the checkpoint does not hold.

The trigger that reproduces all four: enable the example, let the agent create a file,
`/fork` to an earlier entry, accept the restore, observe the new file still present and no
checkpoint at all after a restart.

## Goals

- [ ] A checkpoint captured on a dirty worktree and restored after further edits leaves
      the worktree byte-identical to its state at capture, asserted by comparing
      `git status --porcelain` and every file's contents before and after.
- [ ] A machine that configures `core.autocrlf` does not change what a restore writes,
      asserted by a repository with `core.autocrlf=true` round-tripping both an LF file and
      a CRLF file unchanged.
- [ ] Capturing a checkpoint does not modify the index, the worktree, `HEAD`, the current
      branch, or the stash, asserted by comparing `git status --porcelain`,
      `git rev-parse HEAD`, and `git stash list` across a capture.
- [ ] A checkpoint survives `git gc --prune=now --aggressive`, asserted by running it
      between capture and restore.
- [ ] A checkpoint survives process restart, asserted by resolving it through a second
      engine instance constructed from nothing but the workspace path.
- [ ] Untracked files are captured and restored, and files matched by `.gitignore` are
      neither captured nor touched by a restore.
- [ ] A file created after the checkpoint is removed by the restore.
- [ ] A restore first writes a checkpoint of the pre-restore state, so the restore is
      itself reversible, asserted by restoring that checkpoint and recovering the
      post-checkpoint state.
- [ ] Checkpoint commits carry a fixed `apex-code` identity and never depend on the user's
      configured `user.name` or `user.email`, asserted in a repository with no identity
      configured.
- [ ] The engine no-ops without throwing outside a git repository, in a repository with no
      commits, and when the `git` binary is absent.
- [ ] A session with `checkpoints` unset writes no ref and runs no `git` subprocess,
      asserted by a repository whose ref namespace is empty after a turn.
- [ ] The static prompt prefix is unchanged, asserted by the absence of any new entry in
      `ToolName`.

## Non-goals

- [ ] **A `git` tool in the registry.** ADR 0010 requires every tool to declare four
      contract axes, and ADR 0011's deferred-schema accounting prices a tool at roughly
      77 tokens of static prefix. The agent already runs git through `bash`, with a
      projected identity inside the sandbox since U1. A tool would buy nothing and cost
      the prefix, so the engine is a service the harness calls, never a model-callable
      tool.
- [ ] **Auto-commit onto the user's branch.** `examples/extensions/auto-commit-on-exit.ts`
      writes real commits onto whatever branch is checked out. That is a policy decision
      about someone else's history and belongs to the user, not to a default. Checkpoints
      live in their own ref namespace and never move a branch or `HEAD`.
- [ ] **Touching the stash.** The stash is a user-facing surface with its own stack
      semantics. Writing to it would put harness state where the user keeps theirs, and
      the example's use of `git stash create` is the reason defect 2 exists.
- [ ] **Restoring ignored files.** `.gitignore` names what the user has said is not
      content. Build outputs, `node_modules`, and `.env` are the common cases, and
      reverting them would be destructive in a way no user asked for.
- [ ] **A new session format version.** Checkpoints key off the entry id that v3 already
      carries. Storing them in the session file would force v4 on every user for a feature
      most will not enable, and would make a session file unreadable by a build without
      the feature.
- [ ] **Automatic pruning of another session's refs.** A ref namespace is per session id.
      One session must not delete another's checkpoints, because concurrent sessions in one
      workspace are supported and the other session may still be live.
- [ ] **Windows support beyond what git itself provides.** The engine shells out to `git`
      and holds no platform assumption, but the sandbox remains Linux and macOS per ADR
      0005, and this spec does not change that.

## Proposed solution

Four units. Each lands independently and each ends in its own check.

### C1 — The checkpoint engine

| Component | Change | File(s) |
| --- | --- | --- |
| Engine | Capture, lookup, list, restore, prune over a ref-backed registry | `core/checkpoints/git-checkpoints.ts` (new) |
| Barrel | Re-export the public surface | `core/checkpoints/index.ts` (new) |

The organizing structure is a **registry keyed by session and entry id, backed by git refs
rather than by a process-local map**. That single choice is what fixes defects 1 and 2:
the ref makes the commit reachable, so gc cannot reap it, and the ref lives in `.git`, so
a restart resolves it without any Apex-side persistence.

Capture, exactly:

1. `git rev-parse --git-dir` to confirm a repository. Failure returns `undefined`.
2. `GIT_INDEX_FILE=<temp> git read-tree HEAD`, tolerating failure so a repository with no
   commits still works.
3. `GIT_INDEX_FILE=<temp> git add -A`, which honours `.gitignore` and includes untracked
   files.
4. `GIT_INDEX_FILE=<temp> git write-tree`.
5. `git commit-tree <tree>`, with `-p HEAD` only when `HEAD` resolves, and with
   `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set to a fixed `apex-code` identity.
6. `git update-ref refs/apex-code/checkpoints/<sessionId>/<entryId> <commit>`.

The temp index is what keeps the user's real index untouched, and it is created with
`mkdtemp` so two captures cannot collide on the same path.

Restore, exactly:

1. Capture the current state first, under the reserved entry id `pre-restore`, so the
   restore is reversible.
2. Seed a second temp index from the **current** worktree, so files created after the
   checkpoint are in it and therefore get removed.
3. `GIT_INDEX_FILE=<temp> git read-tree -u --reset <commit>`, which updates the worktree.
4. `git read-tree HEAD` on the real index, leaving the worktree alone, so `git status`
   afterwards shows the checkpoint's changes as unstaged, which is the shape the user had.

### C2 — Settings key

| Component | Change | File(s) |
| --- | --- | --- |
| Schema | `checkpoints?: CheckpointSettings` with `enabled` and `maxPerSession` | `core/settings-manager.ts` |

Absent by default. The key is read where the engine is constructed, and an absent key
constructs nothing, so an unconfigured session runs no `git` subprocess at all.

### C3 — Session wiring

| Component | Change | File(s) |
| --- | --- | --- |
| Capture | Snapshot at turn start, keyed to the current leaf entry | `core/agent-session.ts` |
| Restore | Offer restore when a fork targets an entry that has a checkpoint | `core/agent-session-runtime.ts` |

`beforeToolCall` is untouched. No unit changes what the tool gate sees or when it runs.
Evidence capture is untouched. The engine emits no evidence because it is not a tool call
and produces no model-visible result.

### C4 — Example and documentation

| Component | Change | File(s) |
| --- | --- | --- |
| Example | Rewrite onto the engine, or delete if C3 makes it redundant | `examples/extensions/git-checkpoint.ts` |
| User guide | Document the setting, the ref namespace, and how to remove the refs | `docs/user-guide.md` |

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `examples/extensions/git-checkpoint.ts` in-memory `Map` checkpoint store | code | superseded by the ref-backed registry in `core/checkpoints/git-checkpoints.ts` |
| `git stash create` as Apex's capture mechanism | behaviour | removed. It writes a dangling commit and omits untracked files; `commit-tree` over a temp index replaces it |
| `git stash apply` as Apex's restore mechanism | behaviour | removed. It merges rather than restores; `read-tree -u --reset` replaces it |
| `agent_settled` checkpoint clearing | behaviour | removed. Checkpoints are bounded by `maxPerSession` and pruned by session id instead of wiped per agent run |

Nothing user-facing is removed. No settings key, session field, ref, or CLI flag that
works today stops working.

## Risks

**A ref namespace grows without bound.** A long session captures one checkpoint per turn,
each pinning a full tree. Git shares unchanged blobs, so the marginal cost is the changed
files plus a tree, but a thousand-turn session in a large repository is real disk. The
signal is `git count-objects -vH` growing across a session. `maxPerSession` bounds the
count by pruning the oldest ref, and the prune is by session id so a concurrent session is
untouched.

**A restore destroys uncommitted work the user wanted.** This is inherent to restore and
is why step 1 captures the pre-restore state first. The signal that this is working is the
`pre-restore` ref existing after any restore; the test asserts recovery through it.

**`git add -A` on a repository with a very large untracked tree is slow.** A user who has
not gitignored `node_modules` pays a full scan every turn. The signal is turn latency. The
engine takes a timeout and abandons a capture that exceeds it rather than stalling the
turn, and a failed capture is never fatal.

**A repository-local `core.hooksPath` or a pre-commit hook fires.** It does not.
`commit-tree` and `update-ref` are plumbing and run no hooks, which is a second reason to
prefer them over `git commit` or `git stash`.

**Line-ending conversion rewrites the worktree on restore.** Capture and restore both move
content through git's clean and smudge filters, so anything that converts line endings
applies twice and not necessarily symmetrically. Two settings can do it, and they are not
the same kind of thing.

`core.autocrlf` belongs to the machine and is `true` by default on Windows. Left alone, a
file the agent wrote with LF endings is captured as LF and restored as CRLF, so accepting a
restore silently rewrites line endings across the worktree. Every checkpoint invocation
therefore runs with `-c core.autocrlf=false`, which makes the round trip byte-exact. This is
not hypothetical: it failed `windows-latest` on the first CI run for this branch, on the two
restore tests, and it reproduces on Linux by setting `core.autocrlf=true` in the repository
or by pointing `GIT_CONFIG_GLOBAL` at a config that does.

`.gitattributes` belongs to the repository and is deliberately left alone. A repository
declaring `* text=auto` gets platform-native endings from every ordinary `git checkout`, and
a restore that ignored that would disagree with git itself on the same files. The
consequence, stated rather than hidden: in such a repository on Windows, restoring a file
the agent wrote with LF endings yields CRLF, exactly as `git checkout` would. The signal is
a user reporting whole-file line-ending diffs after a restore, and the check is whether the
repository declares `text` for those paths.

**A workspace that is a subdirectory of a repository captures the whole repository.**
`rev-parse --git-dir` succeeds from any depth, and `add -A` and `read-tree -u` both operate
on the enclosing worktree rather than the current directory. So opening `repo/packages/web`
as the workspace snapshots and restores all of `repo`. This is left as-is deliberately:
there is one repository and one worktree, and scoping a restore to a subtree would leave
the index disagreeing with the worktree for every path outside it. The signal is a user
reporting that a restore reverted files outside their workspace, and the mitigation is the
`pre-restore` ref, which makes that recoverable. Documented in `docs/user-guide.md` rather
than prevented.

## Verification

- Three-OS CI is load-bearing for this change, not a formality. The engine shells out to
  `git`, and the one defect that reached CI was a Windows-only line-ending conversion that
  Linux and macOS both passed.
- `packages/coding-agent/test/checkpoints/git-checkpoints.test.ts` — the engine against a
  real git repository created with `mkdtemp`, never the repo under test, per `AGENTS.md`.
  Every goal above maps to a case in this file.
- `npx tsgo --noEmit` for the type surface.
- `npm run check` for lint and docs gates.

This serves no roadmap phase gate, so there is no corpus metric or threshold to meet.

## Rollout

Needs `docs/plans/2026-08-28-git-checkpoints.md` because it lands in four units with their
own status tracking, and because C3 and C4 depend on C1 and C2 being green first.

No ADR. Nothing here is irreversible or contested. The one decision that could have needed
one, whether checkpoints justify a `git` tool, is settled against by ADR 0010 and ADR 0011
already, and § Non-goals records the reasoning rather than re-opening it.
