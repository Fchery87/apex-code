# Spec: Make built features reachable from the terminal

**Status:** Draft

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Created | `2026-10-03` |
| Last updated | `2026-10-03` |
| Roadmap phase | `none — product-surface follow-up` |
| Tracking issue/PR | none |
| Compatibility posture | `Additive, with one clean break on a key binding. No session file, CLI flag, or tool schema changes shape. The tree navigation prompt, the plan approval prompt, the task panel, and the turn summary are new chrome. A permission mode chosen inside a running session is new state that is never persisted (ADR 0037); /settings keeps writing the user-scope default exactly as today. The thinking-level cycle moves from Shift+Tab to alt+t so Shift+Tab can cycle permission modes; recorded in CHANGELOG.md, and the old key can be restored through keybindings.json.` |

## Summary

Four features work and are tested in the core but cannot be reached from the
terminal: restoring files from a checkpoint during `/tree` navigation, leaving plan
mode when a plan is approved, the `todo_write` task list, and a permission mode
switch scoped to the running session. This spec wires each one to the TUI, adds a
short end-of-turn summary line, and corrects two records that say more shipped than
did.

## Context

- `docs/research/2026-10-03-harness-display-survey.md` records how Codex CLI, Claude
  Code, and Gemini CLI handle the same four surfaces as of 2026-10-03. It is the only
  source of outside behavior in this spec.
- `docs/specs/2026-09-01-harness-correctness-and-workspace-state.md` § 4 requires that
  "Interactive mode asks before a restore that would change files." Task WS.6
  (`8a36f1838`) built the `navigateTree({ workspacePolicy })` contract and its
  outcomes. It changed `agent-session.ts`, `git-checkpoints.ts`, and one test. No mode
  adapter passes a policy, so every navigation uses `keep`.
- `docs/specs/2026-08-11-permission-rule-model.md` assigned "plan-mode UX, the
  `ExitPlanMode` tool, plan presentation, and approval flow" to Phase 4. Task 4.5
  built `plan_present`, which "deliberately does not itself transition permission
  mode, since no such seam exists for tools or extensions today." No later task added
  that seam.
- Task 4.3 built `todo_write` as storage only: a `todo` custom entry read by
  `getLatestTodos()`. That function has no production caller.
- `docs/adr/0004-permission-rule-model.md` orders sources
  `policy > flag > local > project > user > cliArg > command > session`.
  `MODE_SOURCE_ORDER` in `permissions/startup.ts` applies the same order to modes, so
  `session` ranks lowest.
- `42b9865e5` activated `web_search` because it "has been registered in every session
  since Phase 4 but was never in the default active tool set". The same is true of
  `todo_write`, `ask_user`, `plan_present`, `web_fetch`, `skill_search`, and `test`.
- `docs/specs/2026-09-22-transcript-polish.md` and
  `docs/specs/2026-09-25-collapsed-by-default-transcript.md` already deliver counted
  tool previews, per-call disclosure, and the Ctrl+O detail cycle. This spec does not
  revisit them.

## Current state

| Surface | Core | Terminal |
| --- | --- | --- |
| Checkpoint restore | Checkpoint captured before every turn. `navigateTree` accepts `keep`, `restore`, `fail-if-drifted`, `cancel`, and pins a pre-restore checkpoint. | `interactive-mode.ts:2111` and `:5951` never pass `workspacePolicy`. No prompt exists. |
| Plan approval | `plan_present` asks yes/no through `ctx.ui.confirm` and records `approved`. | Approval changes nothing. `plan_present` is not active by default and plan mode does not activate it. |
| Permission mode | `setPermissionMode()` writes `destination: "user"`. The store accepts `session`, which ranks lowest. | Changed only from `/settings`, which saves a global default. No key cycles it. The footer shows the mode. |
| Task list | `todo_write` saves a full-replace list per call. | Never rendered. Tool not active by default. |
| Turn summary | Turn start and end events exist. | No end-of-turn line. |

## The problem

A user who navigates back with `/tree` expects their files to come back with the
conversation, or at least to be asked. They are not asked, and the files never move,
even though Apex saved exactly what it needs to restore them.

A user in plan mode approves a plan and the agent is still blocked from editing. The
only way out is `/settings`, which also changes the default for every future session.

An agent that keeps a task list does so invisibly. The user cannot see progress.

Each of these passed review because its tests stopped at `AgentSession`. Nothing
required a test that drives the interactive mode.

## Goals

- [ ] **G1 — Restore prompt.** Choosing an entry in `/tree` asks whether to restore
      files only when the target has a checkpoint and the workspace differs from it.
      The first and default option keeps current files. The outcome is reported in one
      line.
- [ ] **G2 — Session mode.** A key cycles the permission mode for the running session
      only. The footer shows the mode and that it is session-scoped. `/settings`
      still sets the saved default.
- [ ] **G3 — Plan approval.** In plan mode, `plan_present` is active and offers three
      choices: approve and accept edits, approve and ask before edits, or keep
      planning. Approving switches the session mode.
- [ ] **G4 — Task panel.** When `todo_write` is active and the latest list has items,
      a panel above the composer shows them, collapsed to one counted line by default
      and expandable. It survives resume and follows tree navigation. The tool stays
      opt-in.
- [ ] **G5 — Turn summary.** A completed turn ends with one dim line giving its
      duration. An interrupted turn says so.
- [ ] **G6 — Records corrected.** The workspace-state spec gains an amendment saying
      WS.6 shipped without mode adapters and pointing here. The roadmap's Phase 6 row
      says the daemon is verified in tests and not started by the CLI.
- [ ] **G7 — Proven at the mode boundary.** Every goal from G1 to G5 has at least one
      test that drives the interactive mode or its component, not only `AgentSession`.

## Non-goals

- Starting the durable-state daemon from the CLI. Whether to wire it or retire it is a
  separate decision; G6 only makes the record honest.
- Restoring files without moving the conversation ("restore code only"), or
  summarize-from-here. Both are useful and both need engine work this spec does not
  scope.
- Restoring files on `/fork`. The workspace-state spec keeps fork file-neutral by
  design.
- Turning `todo_write` on for every session. Codex and Claude Code both moved their task
  tools toward opt-in for current models (research § Task list).
- Projecting the task list back into model context after compaction.
- An evidence viewer, an `/agents` panel, `/diff`, `/status`, `/ps`, or an active-agent
  footer label. The research ranks these lower; each can follow separately.
- Codex's "clear context and implement" option.
- A script-driven status line, declined in
  `docs/research/2026-09-22-antigravity-cli-comparison.md`.

## Approach

### G1 — Restore prompt

**Data.** A read-only preview on `AgentSession`:

```ts
type TreeWorkspacePreview =
  | { state: "no-checkpoint" }
  | { state: "unavailable"; reason: string }
  | { state: "matches" }
  | { state: "differs" };

previewTreeWorkspace(targetId: string): Promise<TreeWorkspacePreview>;
```

It runs the same `engine.lookup()` and `engine.matchesWorktree()` steps as
`_resolveTreeWorkspaceStep`, with no restore, and never throws. `matchesWorktree`
returning `undefined` maps to `unavailable`.

**Flow.** In the tree selector's selection handler (`interactive-mode.ts:5951`), call
`previewTreeWorkspace()` before `navigateTree()`. Only on `differs`, show a select:

1. `Keep current files` (default)
2. `Restore files to this point`
3. `Cancel`

Pass `keep`, `restore`, or return without navigating. On any other preview state,
navigate with `keep` and no prompt. After navigation, show one status line from the
returned `workspace` outcome, for example `Restored files · pre-restore checkpoint
saved` or `Files unchanged · no checkpoint for this point`. A `failed` outcome shows
its warning.

The extension command API's `navigateTree` (`interactive-mode.ts:2111`) gains an
optional `workspacePolicy` passed straight through, so extensions are not stuck on
`keep`. RPC and ACP expose no tree navigation command today (`rpc-types.ts` has only
`get_tree`), so they need no change.

Double-Esc already opens `/tree` when `doubleEscapeAction` is `tree`, so it inherits
the prompt with no new binding.

### G2 — Session mode

**Settled by [ADR 0037](../adr/0037-interactive-session-mode-layer.md).** A
session-scoped write cannot work under ADR 0004's order, because `session` ranks below
every file source. Changing `session`'s rank would also change how session rules
resolve, including the deny rule "Reject always" writes. So the mode lives in a
separate, mode-only layer:

- The running interactive session holds an optional `interactiveMode`. It is set only
  by the cycle key and by plan approval, and is never written to disk.
- When set, it is the effective mode for that session above every other source,
  including `flag`. Rules are unaffected; only the mode changes.
- `bypassPermissions` joins the cycle only when the session started with it in force,
  from the flag or a file. The cycle can never escalate past what startup allowed.
- `getPermissionMode()` reports origin `"interactive"` so the footer and `/settings`
  can say the saved default is shadowed for this session.

ADR 0037 refines how modes resolve in an interactive session. It leaves ADR 0004's
rule model unchanged, so ADR 0004 is not superseded. ACP's `setMode` is out of scope
and keeps writing user scope.

**Flow.** A new keybinding `app.permissionMode.cycle` cycles `default → acceptEdits →
plan → default`, with `bypassPermissions` added before `default` when allowed. The
footer's existing mode segment gains a short session marker and the cycle hint.

**Key binding (settled 2026-10-03).** `app.permissionMode.cycle` takes Shift+Tab, the
key Codex and Claude Code both use for permission modes (research § Plan approval and
permission modes). `app.thinking.cycle` moves from Shift+Tab to `alt+t`, which no
default binding in `core/keybindings.ts` or the `pi-tui` editor uses. `/thinking`
still sets the level directly. Both stay user-rebindable. Every place that names the
old binding is updated in the same change: the thinking-cycle row in `README.md`,
`docs/keybindings.md`, and the TUI hints that render it live, which follow
automatically from `keyDisplayText()`. The change goes in `CHANGELOG.md` with the
rebinding path for anyone who wants the old key back. On macOS, `alt+t` needs Option
configured as Meta, the same requirement as the existing `alt+` bindings.

### G3 — Plan approval

**Data.** `plan_present` takes an injected presenter, the same pattern `todo_write`
uses for its store:

```ts
type PlanDecision = { approved: true; nextMode: "acceptEdits" | "default" } | { approved: false };
interface PlanPresenter { present(plan: string, ctx: ExtensionContext): Promise<PlanDecision> }
```

`AgentSession` supplies the presenter. It renders the plan and asks through
`ctx.ui.select`:

1. `Yes, and accept edits`
2. `Yes, and ask before each edit`
3. `No, keep planning`

On approval it sets `interactiveMode` (G2) to `nextMode`. The default presenter,
used when no session supplies one, keeps today's headless failure: it throws when
`ctx.hasUI` is false.

`PlanPresentDetails` keeps `approved` and gains optional `nextMode`. The `workflow`
evidence record gains the same optional field, so existing readers are unaffected.

**Activation.** While the effective mode is `plan`, `plan_present` is in the active
tool set. When the session leaves plan mode it is removed again, unless the user
listed it explicitly in `--tools` or `defaultTools`.

### G4 — Task panel

**Data.** No new storage. The panel reads `getLatestTodos()` over the current branch,
on session load, after each `todo_write` result, and after tree navigation. So branch
and resume are correct for free.

**Rendering.** A component in the existing widget area above the composer, shown
only when the list is non-empty and at least one item is not `completed`.

- Collapsed (default): one line, for example `Tasks 1/4 · Harden client retries`,
  naming the `in_progress` item.
- Expanded: up to five items with distinct glyphs for completed, in progress, and
  pending, and `+N more` beyond five.
- When every item is completed, the panel hides at the end of the turn.

The toggle is a `/tasks` command and a keybinding `app.tasks.toggle`. Ctrl+T is
already `app.thinking.toggle`, so the default key is chosen at implementation from the
free set and recorded. The expanded or collapsed choice is saved as a global setting,
as `chatDetail` is.

The `todo_write` tool cell renders as a compact `Task list updated · 1/4 complete`
instead of the generic tool display.

**Opt-in.** The tool stays out of the default active set. A `/settings` row adds or
removes `todo_write` from `defaultTools`, so enabling it no longer means editing JSON.

### G5 — Turn summary

On `agent_end` for a turn that completed, append one dim line `Worked for 1m 2s`.
An aborted turn shows `Interrupted after 12s`. The duration is wall-clock time from
the turn's first `turn_start` to `agent_end`, so multi-step turns are counted once.
Turns under one second show nothing. The line is chrome, not a session entry, so it
does not reach the model or the session file.

### G6 — Records

- Append an `### Amendment (2026-10-03)` to the workspace-state spec's "Landed
  behavior" section. It says WS.6 delivered the session contract only, that the plan
  row's "modes pass the option through" was incorrect, and that this spec delivers the
  interactive prompt.
- Change the roadmap Phase 6 row to say the daemon, journal, and leases are verified
  by tests and not started by the CLI, and that `apex-code cost` and the usage store
  use the SQLite sidecar.

## Alternatives considered

- **Raise `session` in ADR 0004's order instead of adding a mode-only layer.** Rejected:
  it would also reorder session rules, changing what "Reject always" means.
- **Let `plan_present` change the mode through a new `ExtensionContext` method.**
  Rejected: it would let any extension tool escalate the mode. An injected presenter
  keeps the power inside the session.
- **Turn `todo_write` on by default, as `web_search` was.** Rejected: both reference
  harnesses moved the equivalent tool to opt-in for current models, and a deferred tool
  that the model is not prompted to use spends a name for little gain.
- **Render the task list only in the transcript, as Codex does.** Rejected: Codex's open
  issue #18920 is exactly that the list disappears while idle.
- **Always ask on `/tree`, even when files would not change.** Rejected: it trains the
  user to dismiss a prompt that is usually meaningless.
- **Put the turn summary in the footer instead of the transcript.** Rejected: the
  footer is overwritten by the next turn, and the line is most useful when scrolling
  back.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `plan_present`'s direct `ctx.ui.confirm` call and its "deliberately does not itself transition permission mode" comment (`core/tools/plan-present.ts`) | code, comment | Replaced by the injected `PlanPresenter`. |
| The implicit `keep` at both TUI `navigateTree` call sites (`interactive-mode.ts:2111`, `:5951`) | behavior | Replaced by an explicit policy chosen from the preview. |
| "Landed" wording for Phase 6 in `docs/roadmap.md` | doc | Replaced by an accurate statement (G6). |
| The WS.6 claim that modes pass the policy through | record | Corrected by amendment in the workspace-state spec. The plan holding it was already deleted. |
| `getLatestTodos()` as test-only code | status | Gains its first production caller; nothing removed. |
| `shift+tab` as the default for `app.thinking.cycle` (`core/keybindings.ts`) | binding | Replaced by `alt+t`. Shift+Tab moves to `app.permissionMode.cycle`. |
| "Shift+Tab — Cycle thinking level" in `README.md` and the `app.thinking.cycle` row in `docs/keybindings.md` | doc | Rewritten for the new bindings. |

No source file, session format, or setting is removed.

## Risks

- **Mode override surprise.** A user sets a default in `/settings`, then a session runs
  in another mode. Early signal: the footer marker and `/settings` both name the
  session override; a test asserts both.
- **Shift+Tab muscle memory.** Moving the thinking cycle breaks a habit inherited from
  Pi, and a user who presses Shift+Tab expecting a thinking change gets a mode change
  instead. Mitigations: the footer shows the new mode at once, the changelog names the
  rebinding path, and a one-time hint on the first Shift+Tab after upgrade says the
  thinking cycle is now `alt+t`.
- **`--permission-mode` no longer pins an interactive session.** ADR 0037 accepts this
  as its main cost. An operator who needs a locked mode runs non-interactively.
- **Restore overwrites external edits.** Mitigated by the default `Keep`, the existing
  pre-restore checkpoint, and showing the prompt only on `differs`.
- **Preview cost on large repositories.** `matchesWorktree` builds a temporary index.
  It is bounded by the engine timeout, and a timeout becomes `unavailable` with no
  prompt, never a guessed restore.
- **Panel height on short terminals.** The collapsed panel is one line; the expanded
  panel caps at five items plus one overflow line. Frame cost is checked with
  `test/streaming-render-bench.ts` against trunk, back to back on an idle host, as
  AGENTS.md requires.
- **Model ignores `plan_present`.** If the model never calls it, plan mode still only
  exits by the cycle key. Early signal: a replay check that a plan-mode turn calls it.

## Verification

Each goal has a test at the mode or component boundary (G7). All tests that drive a
turn or write a session `chdir` to a scratch directory.

| Goal | Evidence |
| --- | --- |
| G1 | `test/tree-workspace-prompt.test.ts` drives the tree selection handler: no prompt on `no-checkpoint`, `matches`, `unavailable`; prompt on `differs`; each option maps to its policy; `Cancel` leaves conversation and files unchanged; the outcome line matches the returned outcome. A scratch Git repo proves a real restore and a real keep. `test/agent-session-tree-workspace-policy.test.ts` gains `previewTreeWorkspace` cases. |
| G1 | The extension `navigateTree` passes `workspacePolicy` through (extension API test). |
| G2 | `test/permissions/interactive-mode-override.test.ts`: override beats `flag`, `local`, `project`, `user`; rules are unchanged; nothing is written to disk; `bypassPermissions` appears in the cycle only when allowed at startup. A footer render test shows the session marker. |
| G3 | `test/tools/plan-present.test.ts` covers the three decisions, `nextMode`, the headless throw, and the evidence field. An interactive test proves approval leaves plan mode and that `plan_present` joins and leaves the active set with plan mode. |
| G4 | `test/task-panel.test.ts` renders collapsed, expanded, overflow, and all-complete states; an `AgentSession` test proves the panel follows tree navigation and resume. `test/settings-selector.test.ts` covers the task-list tool row. |
| G5 | A component test renders `Worked for`, `Interrupted after`, and nothing under one second, and asserts no session entry is written. |
| G6 | `node scripts/validate-docs-lifecycle.mjs .` passes, and the two edited records read as described. |

Then `npx tsgo --noEmit`, `npm test`, and `npm run check`.

## Rollout

ADR 0037 (G2's mode layer) and the Shift+Tab binding are settled. Needs a plan under
`docs/plans/`. The suggested order is G6,
G1, G5, then G2, G3, G4, because G1 and G5 have no dependencies and G3 depends on G2.
Each user-visible change goes under `[Unreleased]` in
`packages/coding-agent/CHANGELOG.md`.
