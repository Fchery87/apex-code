# Research: What current harnesses put on screen, October 2026

**Date:** 2026-10-03
**Status:** Complete
**Scope:** How Codex CLI, Claude Code, and Gemini CLI show task lists, plan approval,
checkpoint rewind, permission modes, and turn output in the terminal, compared with what
Apex Code has built but does not show.

## Executive summary

An audit of Apex Code on 2026-10-03 found four features whose core works and is tested
but that no user can reach from the terminal: checkpoint restore during `/tree`
navigation, leaving plan mode after a plan is approved, the `todo_write` task list, and
the Phase 6 durable-state daemon. This survey checks what the current leading harnesses
do in the same places, so the follow-up spec is set against present practice rather than
against memory.

Three findings change or sharpen the follow-up:

1. **Checkpoint rewind with file restore is a differentiator, not table stakes.** Claude
   Code restores code, conversation, or both from one menu. Codex's Esc Esc backtrack
   rewinds the conversation only and leaves files changed. Gemini CLI's `/restore` is off
   by default. Apex already captures a checkpoint before every turn, so wiring the
   restore prompt puts it at parity with the strongest implementation.
2. **Approving a plan switches the permission mode in both Codex and Claude Code.** Both
   present a three-option prompt. Both switch modes per session with Shift+Tab. Apex can
   change mode only through `/settings`, which writes the user-scope file, and its
   `session` source ranks lowest in mode precedence. A per-session mode switch is a
   prerequisite, not polish.
3. **The structured task-list tool is moving to opt-in.** Codex v0.152 (September 2026)
   removed `update_plan` from default prompts. Claude Code enables its task tools by
   default only on older model families. Apex should not switch `todo_write` on for
   every session. It should render the list well when the tool is active.

## Sources and method

All sources are public. Codex CLI is Apache-2.0, and its TUI snapshot tests record the
exact rendered terminal output, which is better evidence than prose descriptions.
Nothing here comes from the unlicensed tree that ADR 0002 forbids. These are behavioral
observations; no source text is to be copied.

- Codex changelog, retrieved 2026-10-03: <https://learn.chatgpt.com/docs/changelog>
- Codex releases: <https://github.com/openai/codex/releases> (latest stable 0.160.0, 2026-10-01)
- Codex slash commands: `codex-rs/tui/src/slash_command.rs` in <https://github.com/openai/codex>
- Codex TUI snapshot tests, same repository:
  - `tui/src/history_cell/snapshots/…plan_update_with_note_and_wrapping_snapshot.snap`
  - `tui/src/history_cell/snapshots/…ran_cell_multiline_with_stderr_snapshot.snap`
  - `tui/src/exec_cell/snapshots/…truncated_live_output_preview_and_transcript.snap`
  - `tui/src/app/snapshots/…owned_transcript__input_tests__plan_prompt_selection.snap`
  - `tui/src/chatwidget/snapshots/…final_worked_for_uses_cumulative_turn_duration.snap`
  - `tui/src/chatwidget/snapshots/…status_line_model_with_reasoning_plan_mode_footer.snap`
  - `tui/src/bottom_pane/snapshots/…footer_status_line_with_active_agent_label.snap`
- Codex issues: [#18920](https://github.com/openai/codex/issues/18920) (task list not
  kept mounted while idle), [#16765](https://github.com/openai/codex/issues/16765)
  ("Updated Plan" wording), [#11626](https://github.com/openai/codex/issues/11626)
  (request for `/rewind` that reverts files)
- Codex v0.152 planning-tool change (secondary source):
  <https://codex.danielvaughan.com/2026/09/03/codex-cli-v0152-vim-search-mcp-per-tool-token-limits-planning-tool-opt-in/>
- Codex Esc Esc backtrack behavior (secondary source):
  <https://ficuslink.com/en/r/codex-edit-previous-prompt>
- Claude Code public docs: [checkpointing](https://code.claude.com/docs/en/checkpointing),
  [interactive mode](https://code.claude.com/docs/en/interactive-mode),
  [permission modes](https://code.claude.com/docs/en/permission-modes)
- Gemini CLI: [checkpointing](https://geminicli.com/docs/cli/checkpointing/)

Secondary sources are used only where the primary changelog is silent, and are marked.

## Findings by surface

### Checkpoint rewind

| Harness | Entry point | What it can restore | Default |
| --- | --- | --- | --- |
| Claude Code | `/rewind`, or Esc twice on an empty prompt | Menu: restore code and conversation, conversation only, code only, summarize from or up to a point, or cancel. Code options appear only when that checkpoint has file changes. | On |
| Codex CLI | Esc twice on an empty prompt | Conversation only. Files already changed stay changed. File rollback is an open request (#11626). `/undo` was removed from the docs. | On (conversation only) |
| Gemini CLI | `/restore`, `/restore <file>` | Files and conversation, then re-proposes the tool call | Off |
| Apex Code | Esc twice opens `/tree` or `/fork` (setting `doubleEscapeAction`) | Engine supports `keep`, `restore`, `fail-if-drifted`, `cancel` with a pre-restore checkpoint. No mode adapter passes a policy, so every navigation keeps files. | Checkpoints on; restore unreachable |

Shared shape: the restore question is asked only when restoring would change files, and
"keep my files" is always one keystroke away.

### Plan approval and permission modes

Codex's rendered prompt when a plan is present:

```text
  Implement this plan?

› 1. Yes, implement this plan          Switch to Default and start coding
  2. Yes, clear context and implement  Fresh thread with this plan
  3. No, stay in Plan mode             Continue planning with the model
```

Claude Code offers the same three-way choice: approve into an auto-accepting mode,
approve into a mode that asks per edit, or keep planning. Its docs state that approving
"exits plan mode and switches the session to the permission mode each approve option
describes." Both harnesses cycle modes per session with Shift+Tab and show the active
mode in the footer: Codex as `Plan mode (⇧tab to cycle)`, Claude Code as
`⏸ plan mode on`.

Apex Code: `plan_present` calls `ctx.ui.confirm` and reports `approved`, but its own
comment says it "deliberately does not itself transition permission mode, since no such
seam exists". The TUI changes mode only from `/settings` through
`applyPermissionMode()`, which writes `destination: "user"`. In `MODE_SOURCE_ORDER`
(`permissions/startup.ts`) `session` ranks below `user`, `project`, and `local`, so a
session-scoped write would be ignored whenever any file sets a mode.

### Task list

| Harness | Tool default | Display |
| --- | --- | --- |
| Codex CLI | Off since v0.152 (`[tools.update_plan] enabled = true` to opt in) | History cell `• Updated Plan · 1/4 complete` when compact, full list with `✔` and `□` when expanded. Not kept on screen while idle (#18920, open). |
| Claude Code | On for older model families, opt-in for others | Ctrl+T toggles the checklist in the status area, up to five items, expanded state restored on resume |
| Apex Code | Registered, not active by default | Stored as a `todo` custom entry. Never rendered. Never projected back to the model. |

### Turn output

From Codex snapshots:

- Command cells use a bullet and a tree: `• Ran echo`, then `└` and the output, trimmed to
  head and tail with `… +2 lines` and a hint `⌃t to view transcript`. A failure reads
  `• Failed (exit 1)`.
- After each turn: `Worked for [duration] • [completion time]`.
- Footer: model and reasoning effort on the left, mode on the right. `/statusline` picks
  from a fixed set of built-in items (26 in v0.146.1), not a user script.
- v0.155 shows a live reasoning summary in the status row. v0.159 added a compact welcome
  screen and occasional tips.

Apex Code already has the counted tool-output preview, per-call disclosure, Ctrl+O detail
cycling, a per-tool timer in the panel header, and the permission mode in the footer
(specs `2026-09-22-transcript-polish`, `2026-09-25-collapsed-by-default-transcript`). It
has no end-of-turn summary line.

### Smaller commands Codex exposes and Apex lacks

`/diff` (git diff including untracked files), `/status` (configuration and token use),
`/ps` and `/stop` (background terminals), `/warnings` (retained diagnostics), `/raw`
(copy-friendly scrollback). Codex also shows the active subagent in the footer
(`Robie [explorer]`) and has a paginated `/agents` command center as of 0.160.

## Recommendations

| Rank | Recommendation | Basis |
| --- | --- | --- |
| 1 | Ask before restoring files during `/tree` navigation, only when restoring would change them | Spec already requires it; Claude Code parity; ahead of Codex |
| 2 | Add a per-session permission mode with a Shift+Tab cycle | Both harnesses; prerequisite for 3 |
| 3 | Present plans as a three-way choice that switches mode on approval; activate `plan_present` in plan mode | Both harnesses; Apex's own deferred task 4.5 |
| 4 | Render the task list as a pinned, togglable panel with a compact count; keep the tool opt-in | Codex and Claude Code display; Codex's open #18920 is the failure to avoid; both moved the tool toward opt-in |
| 5 | Add an end-of-turn `Worked for` line | Codex |
| 6 | Consider `/diff`, `/status`, `/ps`, and an active-agent footer label | Codex; small and separable |

Declined here: a script-driven status line (already declined in
`2026-09-22-antigravity-cli-comparison.md`), Codex's hosted-product commands, and voice.

## Related Apex records

- `docs/specs/2026-09-01-harness-correctness-and-workspace-state.md` § 4 — the restore
  prompt this survey confirms.
- `docs/specs/2026-08-13-tool-surface.md` — `plan_present`, `todo_write`, deferred schemas.
- `docs/adr/0004-permission-rule-model.md` — mode source precedence.
- `docs/research/2026-09-23-codex-cli-comparison.md` — Codex workflow comparison; this
  survey covers the display layer it did not.
