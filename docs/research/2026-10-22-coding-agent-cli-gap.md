# Research: What would make Apex Code a more capable coding CLI

**Date:** 2026-10-22
**Status:** Complete
**Question:** Which capabilities in other coding-agent CLIs, as documented on 2026-10-21 and 2026-10-22, are strong additions for Apex Code, and which current Apex Code behaviors are behind that practice?

This note records behavior. It is not a spec, and it is not permission to copy another project's source, types, or strings. ADR 0002 still applies. Claude Code is observed only through its public docs.

## Method

Primary sources, fetched 2026-10-22.

- Apex Code `README.md` covers interactive keys, tools, permissions, checkpoints, and delegation. The roadmap was last updated 2026-10-18. Worktree and tool-loop behavior was checked in `packages/coding-agent` and `packages/agent/src/agent-loop.ts`.
- Claude Code public docs. The changelog's newest listed release is 2.1.308. Also [agents](https://code.claude.com/docs/en/agents), [memory](https://code.claude.com/docs/en/memory), [goal](https://code.claude.com/docs/en/goal), and [worktrees](https://code.claude.com/docs/en/worktrees). The changelog names API version `2026-10-21` from `/claude-api api-version`.
- Codex CLI GitHub releases. The newest stable release with notes is `rust-v0.163.0`, published 2026-10-15. `rust-v0.164.0-alpha.11` was published 2026-10-22. Its release body is only the title, so this note attributes no features to 0.164.
- Gemini CLI changelog index, stable announcements through v0.65.0 on 2026-10-20. <https://github.com/google-gemini/gemini-cli/blob/main/docs/changelogs/index.md>
- OpenCode intro, page updated 2026-10-20. <https://opencode.ai/docs/>

Gemini's October entries, v0.63 through v0.65, cover security, atomic file writes, and session durability. The Gemini product features cited below shipped earlier in 2026 and still appear in that index.

## What the October 3 survey asked for is largely shipped

`docs/research/2026-10-03-harness-display-survey.md` ranked six display gaps. The README now documents the first four:

1. `/tree` asks before restoring files when the workspace differs from the checkpoint.
2. `Shift+Tab` cycles the permission mode for the current session.
3. In plan mode, `plan_present` offers approve-and-accept-edits, approve-and-ask, or keep planning, and approval switches the mode.
4. `Alt+J` or `/tasks` shows the task panel. `todo_write` stays opt-in.

Do not reopen those four. Items 5 and 6 from that survey were not re-checked here. Those are an end-of-turn duration line, and `/diff`, `/status`, and `/ps`.

## Where Apex Code already matches current practice

Building these again would duplicate what is already there.

| Practice | Who shipped it recently | Apex Code |
| --- | --- | --- |
| Steer a running turn | Codex 0.163.0, 2026-10-15, follow-up while responding | `steer` and `followUp` in `agent-session.ts`, with `steeringMode` of `all` or `one-at-a-time` |
| Parallel tool calls in one model turn | Codex 0.163.0, parallel read-only lookups | `executeToolCalls` runs the batch in parallel unless `toolExecution` is `sequential` or one tool declares `executionMode: "sequential"` |
| Atomic file publish | Gemini v0.64.0, 2026-10-13 | `publishByRename` in `path-utils.ts` renames a sibling file over the target. Windows falls back to a direct write when the destination is open |
| Plan mode that does not mutate | Gemini plan mode default since v0.34.0 (2026-03-17). OpenCode Plan/Build on Tab | `plan` keeps tools whose contract is read-only, then adds `grep`, `find`, `ls`, and `plan_present`. A tool with no contract is refused |
| Child isolation by git worktree | Claude Code subagent `isolation: worktree`. Codex 0.162.0 managed worktrees (2026-10-08) | `delegate` accepts `isolation: "worktree"`. `GitWorktreeWorkspaceOwner` creates `.apex-code/worktrees/<sessionId>` and refuses a tree it does not own |
| MCP, hooks, ACP, background shell, checkpoints, evidence, cost | Claude Code, Codex, and Gemini all ship these | Present. The roadmap rows for native MCP, hooks, background shell, ACP, and checkpoints name the commits |

## What is behind current practice

### The README tells the user to supply their own isolation

ADR 0032 (2026-09-12) removed the built-in OS sandbox. The README tells the user to run Docker, a VM, or a dev container themselves. The removed boundary used a supervisor and claimed coverage it did not have.

The other CLIs confine the shell, and they did this before ADR 0032 as well as after it:

- Codex 0.163.0 documents Linux isolation as bubblewrap for the filesystem and seccomp for syscalls. The 0.164 alphas publish `bwrap` binaries.
- Claude Code documents a sandboxed Bash tool with filesystem and network limits, separate from permission mode. The 2.1.305 changelog adds `sandbox.allowNestedUserNamespaces` for Linux.
- Gemini shipped Seatbelt, bubblewrap/seccomp, gVisor, and LXC across v0.34.0 through v0.36.0, then dynamic sandbox expansion with worktrees in v0.37.0 (2026-04-08).

The permission gate still decides whether a call may run. The gap is the missing option to confine `bash` without claiming the old sandbox. The other CLIs confine the shell only, leave it off unless the user turns it on, and fail closed when the helper is missing. That is not the supervisor ADR 0032 removed.

### Instructions are one file, loaded in full, and only the human writes them

Apex Code loads `AGENTS.md` and `CLAUDE.md` at session start, after project trust. Loading one full file is the right default for a short project file. It is a weak default once it is the only way instructions reach the model.

Claude Code, documented on the live memory page:

- Path-scoped rules under `.claude/rules/` with a `paths` frontmatter field. A rule loads when a matching file is read or edited, not at launch.
- Auto memory, on by default in local sessions. Claude writes notes under `~/.claude/projects/<project>/memory/`. The same git repo shares one directory across worktrees. The first 200 lines or 25 KB load. Notes are typed `user`, `feedback`, `project`, or `reference`. Claude is told to skip facts it can derive from the code.
- `/doctor prompt-audit` (v2.1.283 or later) reports stale instructions, missing paths, and files that contradict each other. It writes nothing until the user asks.

Gemini's variant is stricter about review. v0.39.0 (2026-04-23) added a `/memory` inbox. v0.42.0 (2026-05-12) added a canonical-patch contract so extracted notes are reviewed before they become skills.

Apex Code has no path-scoped rules, no cross-session notes the agent writes, and no audit of instruction files.

### No flag starts the user's session in a worktree

The user cannot start their own session in a worktree. A delegated child already can. `reportConcurrentSessionRefusal` tells a second CLI in the same tree to run `git worktree add` by hand.

Claude Code `--worktree [name]` creates `.claude/worktrees/<name>/`, branches it, blocks edits and git commands aimed at the main checkout, copies gitignored files listed in `.worktreeinclude`, and asks before deleting a dirty tree on exit. Subagents can set `isolation: worktree`. Codex 0.162.0 added tools to create and list managed worktrees. Gemini added native worktrees in v0.36.0 (2026-04-01).

### Nothing starts another turn after the model stops

Apex Code stops when the model stops, or when a run budget runs out. When `policies.boundary` is `"post-turn"`, `VerificationTracker` runs the pinned command after the turn and records the exit code. It does not start another turn.

Claude Code documents `/goal` on its live goal page, with behavior notes back to v2.1.234.

- The user states one completion condition.
- After each turn, a separate small model reads the conversation and returns met, not met, or impossible.
- Not met starts another turn. Met or impossible clears the goal.
- The evaluator does not call tools. The condition has to be something the working model already printed, such as a test exit code.
- One goal per session. Resume restores an active goal and resets the turn count.
- It is a session-scoped stop hook, not a new agent loop.

OpenCode's `/undo` and `/redo` restore the last change. They do not keep the session working until a condition holds. Apex Code's checkpoint restore already covers the file rewind.

## Recommendations

Ordered by what they let a user finish.

### 1. A completion check that can start another turn

Borrow the idea of `/goal`, not its prompt text. One active condition per session. After a turn ends, something other than the working model decides whether the condition holds. If it does not, the session continues, and the reason is shown.

Run the check outside the working model, and keep it small. A pinned verification policy is the better first judge. Apex Code already runs one, such as `npm test` exiting 0 or a formatter exiting 0. The exit code does not depend on the transcript. Use a model judge only when the condition cannot be a command. Cap the number of turns. Clear the condition on an auth failure, an exhausted budget, or a context overflow that compaction cannot fix. Do not change the permission mode to make the loop run.

The other CLIs added this because models stop early. Claude Code has `/goal`. Gemini v0.63.0 (2026-10-06) runs an approved plan without waiting for another prompt in non-interactive mode.

### 2. `apex-code --worktree <name>` for the session the user is in

Call `GitWorktreeWorkspaceOwner`. Today only `delegate` calls it. A flag should create the linked worktree, start the session inside it, refuse edits and git commands that target the parent checkout, and on exit remove a clean tree and ask about a dirty one.

Do not add a second worktree directory. Children already use `.apex-code/worktrees/<sessionId>`. A user session can use the same directory with a name the user chose. Copy a declared list of gitignored files, the way Claude Code copies files named in `.worktreeinclude`. A fresh worktree has no `.env` unless something copies it.

Two Apex Code sessions can then change files without sharing a checkout. The concurrent-session refusal can point at the flag instead of a manual git command.

### 3. Notes the agent writes, reviewed before they load

Do not copy Claude Code's default-on auto memory. Use Gemini's inbox instead.

The agent may append a note after a correction. The next session does not load that note until the user accepts it from the inbox.

Cap the loaded notes at 200 lines or 25 KB. Claude Code publishes that limit. Copy the number, not Claude Code's file format. Store the notes once per git repo, so every worktree of that repo reads the same notes. Refuse a note that contains a secret. Refuse a note that only repeats a fact the agent can read from the tree.

Add path-scoped instruction files for rules the human writes. A rule with a path glob loads when a matching file is read or edited. `AGENTS.md` stays loaded at session start, and it should stay short. Apex Code already defers tool schemas and skills the same way.

Add an audit command that reads instruction files and reports contradictions, missing paths, and commands that do not exist. It proposes edits and writes none of them itself.

### 4. Optional shell confinement, documented

Do not restore the removed sandbox. A new spec should answer one question. Can a bash call be limited to the workspace files and an allowlist of hosts, without a supervisor, a proxy, or a second permission classifier?

The other CLIs confine the shell with a platform sandbox. On Linux that is bubblewrap and seccomp. On macOS that is Seatbelt. The sandbox is off unless the user turns it on, and it fails closed when the helper is missing. `read`, `grep`, `find`, and `ls` stay on the permission gate, because those tools do not go through the shell.

ADR 0032 superseded ADR 0005. ADR 0005 rejected a bash-only boundary because `read`, `grep`, `find`, `ls`, extensions, and later child processes would still run outside it. A shell-only feature has to say that limit in the spec. Otherwise it claims the coverage ADR 0005 refused.

Build this after the worktree flag if the two cannot be built at once. Do not describe Apex Code as safe on an untrusted repo without Docker until it exists.

### 5. A browser tool aimed at the app under development

Claude Code documents Chrome attach and, on macOS, computer use of the whole desktop. Gemini has shipped a browser agent since v0.31.0 (2026-02-27), with persistent sessions called out again in v0.37.0. Apex Code has `web_fetch` and no browser.

Build the smaller tool. It opens a localhost URL, reads the console, and returns a screenshot, so the agent can check a UI change. Do not add desktop control of every app. That only runs on some platforms, and it adds permission cases a code change does not need. Keep the first version to loopback addresses. Ask before any other origin. Leave the tool out of the default tool list.

## Small, and not this round

- Codex 0.162.0 and 0.163.0 make wrapped URLs clickable and add a leader key for chords. That is polish on the Ember TUI.
- Codex 0.163.0 has `/side`, a second conversation beside the main thread. Apex Code already branches the session tree. A lighter side thread can wait until worktrees exist.
- OpenCode and Claude Code both have `/init`, which proposes an `AGENTS.md` and does not overwrite an existing file. Fold that into the instruction audit.

## Declined

- Codex and Gemini both ship voice mode. It does not make the agent better at code.
- Claude Code's newest pages are mostly hosted cloud sessions, phone remote control, Slack, and scheduled cloud routines. ADR 0013 forbids a default dependency on a hosted service Apex Code does not run. A local `/loop` can wait until the completion check exists, because a timer without a stop condition repeats the prompt until the user stops it.
- Apex Code already loads trusted TypeScript extensions. A plugin marketplace, org-managed plugin policy, and TUI mods are distribution, not a missing coding capability.
- Claude Code documents agent teams with a shared task list as experimental and off by default. `delegate` plus a user worktree covers the same job with less code.
- Codex ships Daybreak, Cyber access programs, and GPT-6 defaults. Apex Code stays provider-agnostic through `pi-ai`.

## Suggested order

1. Add the completion check. It uses one session and the verification policies that already exist. It adds no isolation code.
2. Add `--worktree` for the user session. `GitWorktreeWorkspaceOwner` already exists.
3. Add reviewed memory, path-scoped rules, and the instruction audit in one spec.
4. Add optional shell confinement under a new ADR. Do not start by reverting ADR 0032.
5. Add a localhost browser tool.

The first three let a session finish a task, run a second task in another checkout, and keep an accepted correction. The fourth is the safety gap. The fifth is how a UI change gets checked.

## Recheck

Checked again against the code on 2026-10-22, after the first draft:

- `packages/agent/src/agent.ts` defaults `toolExecution` to `"parallel"`. `agent-loop.ts` falls back to sequential when any tool in the batch sets `executionMode: "sequential"`.
- `packages/coding-agent/src/core/tools/path-utils.ts` publishes `edit` and `write` by rename, with a Windows fallback when the destination is open.
- `agent-session.ts` `_projectToolNames` keeps plan mode to tools whose contract is not denied, then adds `grep`, `find`, `ls`, and `plan_present`. `PLAN_MODE_SEARCH_TOOLS` is `grep`, `find`, and `ls`.
- `verification-lifecycle.ts` records a post-turn policy result. It does not start another turn.
- `cli/concurrent-session.ts` prints `git worktree add` as the way to get a second tree. No `--worktree` flag exists under `src/cli`.
- Image paste is not a gap. `app.clipboard.pasteImage` is bound to Ctrl+V (Alt+V on Windows) in `core/keybindings.ts`, and `utils/clipboard-image.ts` reads Wayland, X11, and the Windows clipboard from WSL. `cli/file-processor.ts` also accepts image files on the command line.

## Related Apex records

- `docs/research/2026-10-03-harness-display-survey.md` for the display gaps this note treats as shipped.
- `docs/adr/0032-no-built-in-sandbox.md` for why item 4 needs a new decision rather than a revert.
- `docs/adr/0013-no-unowned-hosted-service-defaults.md` for the hosted features this note declines.
- `packages/coding-agent/src/core/workspace/git-worktree-owner.ts` is the code item 2 should reuse.
