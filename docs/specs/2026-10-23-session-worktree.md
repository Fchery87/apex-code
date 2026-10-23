# Spec: A worktree for the session the user is in

**Status:** Draft

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-10-23 |
| Last updated | 2026-10-23 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility. With no `--worktree` flag, startup, the working directory, and the concurrent-session refusal keep their current meaning. A delegated child still uses `GitWorktreeWorkspaceOwner` unchanged. |

## Executive summary

A delegated child can already run in a linked git worktree. The user cannot start their own session that way. A second CLI in the same tree is refused and told to run `git worktree add` by hand.

This spec adds `apex-code --worktree <name>`. The flag creates one linked worktree under `.apex-code/worktrees/<name>`, starts the session inside it, and on exit removes a clean tree and keeps a dirty one. The concurrent-session refusal names the flag.

## Context and motivation

- `docs/research/2026-10-22-coding-agent-cli-gap.md` ranks this second, after the completion check. It says the flag should call `GitWorktreeWorkspaceOwner`, refuse edits and git commands that target the parent checkout, and on exit remove a clean tree and ask about a dirty one. It says not to add a second worktree directory.
- `packages/coding-agent/src/core/workspace/git-worktree-owner.ts` already creates `<workspaceRoot>/.apex-code/worktrees/<sessionId>` on branch `apex-child-<short id>`. `prepare()` throws outside a git repository. `release()` keeps a dirty tree unless the caller passes `force`.
- `packages/coding-agent/src/cli/concurrent-session.ts` prints `git worktree add ../<name> -b <branch>` and `apex-code --allow-concurrent`. There is no `--worktree` flag in `src/cli/args.ts`.
- Claude Code `--worktree [name]` creates `.claude/worktrees/<name>/`, copies gitignored files named in `.worktreeinclude`, and asks before deleting a dirty tree. This spec copies the behavior, not that layout or that filename.

## Current state

`delegate` with `isolation: "worktree"` is the only caller of `GitWorktreeWorkspaceOwner`. The owner refuses an unsafe session id, writes an exclude entry so the worktrees directory stays out of `git status`, and never merges, commits, or pushes.

A second process in the same working tree is refused by the session lease. The refusal text tells the user to create a worktree with git.

## The problem

Two sessions in one checkout overwrite each other's edits. The product already knows how to give a child its own checkout. The user who wants the same thing has to leave the CLI and run git.

## Goals

- [ ] `apex-code --worktree <name>` creates a linked worktree at `<repo>/.apex-code/worktrees/<name>` and starts the session with that directory as its cwd.
- [ ] `<name>` uses the same safe-component rule the owner already uses for a session id. A name with `..`, a slash, or a leading dash is refused before git runs.
- [ ] The worktree is on a new branch named `apex-session-<short name>`. The owner does not reuse `apex-child-`, so a user tree and a child tree cannot collide on the branch name.
- [ ] Outside a git repository, or when git is missing, the flag exits with a message and does not start a session.
- [ ] On exit, a clean worktree is removed. A dirty worktree is kept, and the exit message names its path. Nothing is force-removed, and nothing is merged.
- [ ] The concurrent-session refusal names `apex-code --worktree <name>` and still names `--allow-concurrent`.
- [ ] Tests drive the owner and the flag parser. They use a temporary git repository. They do not touch the repo that contains the test.

## Non-goals

- [ ] A second worktree root. Children stay at `.apex-code/worktrees/<sessionId>`.
- [ ] Copying gitignored files such as `.env` into the new tree. A declared copy list is later work.
- [ ] Blocking an edit or a git command whose path resolves in the parent checkout. The session cwd is the worktree. Path confinement is later work, and it is not this flag.
- [ ] Asking in the interactive UI before deleting a dirty tree. A dirty tree is kept. The user deletes it.
- [ ] Changing `delegate`, `release({ force: true })`, or the branch prefix a child already uses.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Flag | `Args.worktree?: string`. `--worktree <name>` parses like the other value flags. Help text says the session starts in a new linked worktree. | `packages/coding-agent/src/cli/args.ts` |
| Prepare | A function that calls the same git sequence as `GitWorktreeWorkspaceOwner.prepare`, with the branch prefix `apex-session-` and the directory name taken from the flag. It returns the worktree path or throws the owner's existing refusal. | `packages/coding-agent/src/core/workspace/session-worktree.ts` |
| Startup | When the flag is set, startup chdirs to the returned path before the session lease is taken, so the lease belongs to the worktree and not the parent checkout. | the CLI startup that already calls `reportConcurrentSessionRefusal` |
| Release | On process exit, call the same remove-or-keep rule `release()` uses. Print the path when the tree is kept. | same startup file |
| Refusal text | Replace the manual `git worktree add` line with the flag. | `packages/coding-agent/src/cli/concurrent-session.ts` |

`GitWorktreeWorkspaceOwner` stays the child owner. The session function shares its path rule, its exclude entry, and its release rule. It does not take a `ChildWorkspaceRequest`.

## Deletion inventory

The manual `git worktree add` line in `reportConcurrentSessionRefusal` is replaced. No owner method, branch prefix, or directory is removed.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| The flag starts in the parent and the lease still blocks a second session that wanted the parent | medium | A user cannot tell which tree they are in | The lease is taken after chdir, and the refusal prints the cwd it already prints |
| A name that matches a live child session id reuses that directory | low | One tree, two owners | The session branch prefix differs, and prepare fails when the directory already exists |
| Exit cleanup runs after a crash and the tree is left behind | medium | A stale checkout | The next `--worktree` of the same name fails because the directory exists, and the message names it |

## Verification

- Parser test. `--worktree demo` sets the field. `--worktree` with no value is a diagnostic. A name containing `..` is refused by the prepare function before `runGit`.
- Git test in a scratch repository. Prepare creates the directory and the branch. Release removes it when clean and keeps it when a file is untracked. The parent `git status` does not list `.apex-code/worktrees/`.
- Refusal test. The printed text contains `--worktree` and does not contain `git worktree add`.

## Rollout

One change. The flag is off when omitted. No setting, no migration, no session-format change.
