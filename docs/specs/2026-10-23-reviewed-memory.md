# Spec: Notes the agent writes, reviewed before they load

**Status:** Draft

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-10-23 |
| Last updated | 2026-10-23 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility. `AGENTS.md` and `CLAUDE.md` still load in full at session start after project trust. A session with no accepted notes and no path-scoped rules gets the same system prompt it gets today. |

## Executive summary

Apex Code loads one project instruction file at startup, and only the human writes it. The agent cannot record a correction for the next session, a rule cannot load when a matching file is touched, and nothing reports two instruction files that disagree.

This spec adds three pieces in one change. The agent may append a note to an inbox. The next session does not load that note until the user accepts it. A path-scoped rule loads when a matching file is read or edited. An audit command reports contradictions, missing paths, and missing commands, and it writes nothing.

## Context and motivation

- `docs/research/2026-10-22-coding-agent-cli-gap.md` ranks this third. It says not to copy Claude Code's default-on auto memory. It says to use an inbox, cap loaded notes at 200 lines or 25 KB, store them once per git repo, and refuse a note that contains a secret or only repeats the tree. It also asks for path-scoped rules and an audit that proposes edits and writes none.
- `packages/coding-agent/src/core/resource-loader.ts` `loadProjectContextFiles` walks from the cwd to the root and loads the first of `AGENTS.md` or `CLAUDE.md` in each directory, after `projectTrusted` is true. The agent directory's own file loads even when the project is not trusted.
- Skills already load on demand rather than in full at startup. Path-scoped rules should follow that shape. They do not load at launch.
- ADR 0002 still applies. The numbers 200 and 25 KB are the published cap. The file format is not copied.

## Current state

Instruction text that reaches the model is the loaded context files, the system prompt, and appended prompt files. There is no inbox, no per-repo note store, and no command that reads those files and reports a problem.

Project trust already gates the checkout's instruction files. A note store has to sit behind the same gate. An untrusted checkout does not get its notes into the prompt.

## The problem

A correction the user gives in one session is gone in the next. The only way to keep it is to edit `AGENTS.md`, which then loads in full on every turn. Rules that matter for one directory are paid for on every session, and two files can contradict each other with no report.

## Goals

- [ ] The agent can append one note to `<repo>/.apex-code/memory/inbox/`. The file is markdown. The note is not added to the system prompt.
- [ ] Accepting a note moves it to `<repo>/.apex-code/memory/accepted/`. Only accepted notes load, and only after project trust.
- [ ] Loaded accepted notes stop at 200 lines or 25 KB, whichever comes first. The cut is reported. Notes past the cut stay on disk and do not load.
- [ ] The store is one directory per git repository, at the repository root. A linked worktree of that repo reads the same notes. A directory that is not a git repo stores notes under the cwd and says so.
- [ ] A note that matches a known secret shape is refused and not written. The first shapes are an `api_key`, a `token`, a `password`, and a PEM block. The check is a literal scan, not a model call.
- [ ] A path-scoped rule is a markdown file under `.apex-code/rules/` with a `paths` glob in its frontmatter. It is not loaded at session start. It is appended when a `read`, `edit`, or `write` path matches the glob.
- [ ] `apex-code instructions audit` prints contradictions, paths named in instructions that do not exist, and commands named in instructions that are not on `PATH`. It writes no file.
- [ ] Tests use a scratch directory. They do not write into this repo's `.apex-code/`.

## Non-goals

- [ ] Loading a note the user has not accepted. There is no default-on memory.
- [ ] The agent editing `AGENTS.md` or an accepted note. Acceptance is a user action.
- [ ] A model deciding that a note repeats the tree. The research note asks for that refusal. This spec does not add a model call to the write path. A note that only quotes a file is the user's problem at review time.
- [ ] `/init` that proposes an `AGENTS.md`. The research note defers that to the audit. The audit reports. It does not draft a file in this spec.
- [ ] Syncing notes to a hosted service.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Store | Read and append inbox files. Move one file to `accepted/` by name. List accepted files in order, stopping at 200 lines or 25 KB. | `packages/coding-agent/src/core/memory-notes.ts` |
| Tool | `memory_note` takes a title and a body, scans for the secret shapes, and appends under the inbox. The contract is `{fs}`, default `ask`, `deferSchema: true`, no evidence. | `packages/coding-agent/src/core/tools/memory-note.ts` |
| Load | After project trust, append the capped accepted notes to the context files the resource loader already returns. Untrusted projects get none. | `packages/coding-agent/src/core/resource-loader.ts` |
| Rules | Parse `paths` frontmatter. On a matching read, edit, or write, append that rule's body once per session. | `packages/coding-agent/src/core/path-rules.ts`, the tool path that already sees the target path |
| Audit | A CLI subcommand. Read context files, accepted notes, and rules. Print findings. Exit 0 when there are none, exit 1 when there is a finding. | `packages/coding-agent/src/cli/` |

The inbox and the accepted directory are gitignored by the same exclude entry the worktree owner writes, so accepting a note does not dirty the user's tree unless they choose to track it. That choice is a later spec if someone asks.

## Deletion inventory

Nothing existing is removed. `AGENTS.md` and `CLAUDE.md` stay the startup files.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| A secret that does not match the four shapes is stored | medium | The note is on disk until the user reviews it | The note is not loaded until acceptance, and the audit prints the inbox count |
| A path rule matches too broadly and grows the prompt | medium | Later turns cost more | A rule loads once per session, and the audit reports rules whose glob matches nothing |
| Worktrees disagree about which repo root owns the notes | low | Notes appear in one tree and not the other | The root is `git rev-parse --show-toplevel` of the common git dir, the same root the context loader already computes |

## Verification

- Inbox test. Append does not change the loaded prompt. Accept does. The 201st line does not load, and the report names the cut.
- Secret test. A body containing `api_key=` is refused and the inbox is unchanged.
- Rule test. A rule with `paths: ["src/**/*.ts"]` is absent from the startup prompt and present after a matching read.
- Audit test. Two instruction files that name the same command with different arguments produce a finding, and the command writes no file.
- Trust test. `projectTrusted: false` loads no accepted notes from the checkout.

## Rollout

The tool is registered with the other tools. Writing still asks under the default permission mode. Loading is a no-op until a note is accepted. No session-format change.
