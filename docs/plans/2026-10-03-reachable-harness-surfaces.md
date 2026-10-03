# Plan: Make built features reachable from the terminal

**Status:** Not started

**Spec:** [Make built features reachable from the terminal](../specs/2026-10-03-reachable-harness-surfaces.md)

## Tasks

| # | Task | State | SHA | Verified by |
| --- | --- | --- | --- | --- |
| RS.1 | Correct the WS.6 and Phase 6 records (G6) | Not started | — | `node scripts/validate-docs-lifecycle.mjs .` passes; the workspace-state spec carries the 2026-10-03 amendment and the roadmap Phase 6 row says the daemon is test-verified and not started by the CLI |
| RS.2 | Add `AgentSession.previewTreeWorkspace()` (G1) | Not started | — | `test/agent-session-tree-workspace-policy.test.ts` gains preview cases in a scratch Git repo: `no-checkpoint`, `matches`, `differs`, `unavailable` (checkpoints off, and a comparison that cannot run); preview never changes files or the session leaf |
| RS.3 | Ask before restoring files in `/tree`; pass `workspacePolicy` through the extension `navigateTree` (G1) | Not started | — | New `tree-workspace-prompt.test.ts` drives the tree selection handler: no prompt unless `differs`; `Keep current files`, `Restore files to this point`, and `Cancel` map to `keep`, `restore`, and no navigation; the status line matches each outcome; a scratch repo proves real restore and real keep. An extension API test proves the policy passes through |
| RS.4 | Show `Worked for` / `Interrupted after` after each turn (G5) | Not started | — | Component test renders both lines, nothing under one second, one line for a multi-step turn, and asserts no session entry is written |
| RS.5 | Implement the interactive mode layer in the permission core (ADR 0037) | Not started | — | New `interactive-mode-override.test.ts` under `test/permissions/`: the layer beats `flag`, `local`, `project`, `user`; rule resolution is unchanged; nothing is written to disk; resolution origin is `"interactive"`; `bypassPermissions` is selectable only when in force at startup; clearing the layer restores ADR 0004 resolution |
| RS.6 | Bind Shift+Tab to `app.permissionMode.cycle`, move `app.thinking.cycle` to `alt+t`, show the session marker in the footer (G2) | Not started | — | Keybinding tests assert both defaults and no collision; an interactive test cycles `default → acceptEdits → plan → default`, with `bypassPermissions` only when allowed; footer render test shows the session marker; one-time hint test; `README.md` and `docs/keybindings.md` updated |
| RS.7 | Inject a `PlanPresenter` into `plan_present`; switch mode on approval; activate `plan_present` with plan mode (G3) | Not started | — | `test/tools/plan-present.test.ts` covers the three choices, `nextMode`, the headless throw, and the additive evidence field; an interactive test proves approval leaves plan mode through the RS.5 layer and that `plan_present` joins and leaves the active set with plan mode unless listed explicitly |
| RS.8 | Render the pinned task panel, `/tasks`, `app.tasks.toggle`, and the compact `todo_write` cell (G4) | Not started | — | New `task-panel.test.ts` renders collapsed, expanded, overflow (`+N more`), and all-complete states; an `AgentSession` test proves the panel follows tree navigation and resume; the toggle state round-trips through global settings; the chosen default key has no collision |
| RS.9 | Add a `/settings` row that adds or removes `todo_write` from `defaultTools` (G4) | Not started | — | `test/settings-selector.test.ts` toggles the row and asserts `defaultTools` before and after; `todo_write` stays out of the default active set when the row is untouched |
| RS.10 | Phase verification and close | Not started | — | `npx tsgo --noEmit`, `npm test`, and `npm run check` pass; `test/streaming-render-bench.ts` measured trunk against head back to back on an idle host; three-OS CI green; `CHANGELOG.md` `[Unreleased]` names every user-visible change, including the rebinding path for the thinking cycle; spec status set to Landed; plan closed |

States: `Not started`, `In progress`, `Done, unverified`, `Done`.

`Done` requires a real SHA that passes `git cat-file -t`, and a verification that
actually ran. `Done, unverified` is honest and must say what is missing.

## Task details

### RS.1: Correct the records

Append `### Amendment (2026-10-03)` to the "Landed behavior" section of
`docs/specs/2026-09-01-harness-correctness-and-workspace-state.md`. Say that WS.6
delivered the session contract only, that the deleted plan's row claiming the modes
pass the policy through was wrong (recoverable at
`git show b0f599b4a^:docs/plans/2026-09-01-harness-correctness-and-workspace-state.md`),
and that the interactive prompt is delivered by this plan's RS.3.

Rewrite the roadmap's Phase 6 row so it says the daemon, journal, and leases are proven
by `test/durable-state/` and are not started by the CLI, and that the SQLite sidecar is
used by `apex-code cost` and the usage store.

**Done when:** both records read as described and the docs validator passes.

### RS.2: Preview without restoring

Write the failing preview tests first. Then factor the lookup and comparison out of
`_resolveTreeWorkspaceStep` so the preview and the restore path share one
implementation, and expose `previewTreeWorkspace(targetId)` returning the spec's
`TreeWorkspacePreview`. It never throws: an exception becomes `unavailable` with its
reason.

**Done when:** the preview tests fail before the change for the right reason and pass
after it, and the existing policy tests still pass unchanged.

### RS.3: The restore prompt

In the tree selection handler (`interactive-mode.ts`, the `navigateTree` call after
the summary choice), call the preview first. Prompt only on `differs`. Keep the
summary choice and the restore choice as separate questions so neither changes the
other's meaning. Report the `workspace` outcome on one status line. Pass an optional
`workspacePolicy` through the extension command API's `navigateTree` and its type in
`core/extensions/types.ts`.

This is the task that closes the WS.6 gap, so its test must drive the interactive
handler, not only `AgentSession`.

**Done when:** the new test file passes and a manual run in a scratch repo shows the
prompt only after files have changed since the chosen entry.

### RS.4: Turn summary

Record the wall-clock time at the first `turn_start` of an agent run and render the
line at `agent_end`. Abort produces `Interrupted after`. The line is chrome only: no
session entry, no model context.

**Done when:** the component test passes and the line appears in a real session.

### RS.5: Interactive mode layer

Implement ADR 0037 in the permission state. Keep it separate from
`WritablePermissionSource`, so it cannot be written through `store.apply()` and cannot
affect rules. Expose set, clear, and read on `AgentSession`. Extend the mode
resolution origin with `"interactive"`. Record the startup mode so the
`bypassPermissions` ceiling has something to check against.

**Done when:** the override test passes and every existing test under
`test/permissions/` passes unchanged.

### RS.6: Cycle key and footer

Add `app.permissionMode.cycle` with Shift+Tab; move `app.thinking.cycle` to `alt+t`.
Add the new action to the reserved list in `core/extensions/runner.ts` beside
`app.thinking.cycle`. Wire the action to the RS.5 layer. Show a short session marker
and the cycle hint in the footer's mode segment. Show a one-time hint on the first
Shift+Tab after upgrade, remembered in global settings. Update `README.md` and
`docs/keybindings.md`. The in-app hints follow from `keyDisplayText()`.

**Done when:** the tests in the task row pass and a manual run cycles modes with
Shift+Tab and thinking levels with `alt+t`.

### RS.7: Plan approval

Change `createPlanPresentToolDefinition` to accept a `PlanPresenter`. The default
presenter keeps the headless throw. `AgentSession` supplies a presenter that asks the
three-way question through `ctx.ui.select` and, on approval, sets the RS.5 layer to
`nextMode`. Add optional `nextMode` to `PlanPresentDetails` and the `workflow`
evidence record. Make the active tool set track plan mode for `plan_present`, without
removing it when the user listed it explicitly.

**Done when:** the tests in the task row pass and a manual plan-mode session leaves
plan mode on approval.

### RS.8: Task panel

Add a component in the widget area above the composer that reads `getLatestTodos()`
over the current branch. Refresh it on session load, after each `todo_write` result,
and after tree navigation. Collapsed by default to one counted line naming the
in-progress item; expanded shows up to five items and `+N more`. Hide it at turn end
when every item is complete. Add `/tasks` and `app.tasks.toggle`; Ctrl+T is taken by
`app.thinking.toggle`, so choose a free default and record it in the spec. Save the
expanded state as a global setting. Render the `todo_write` tool cell as
`Task list updated · N/M complete`.

**Done when:** the panel tests pass and the render bench shows no regression beyond
contamination, measured as AGENTS.md describes.

### RS.9: Settings row

Add a row to `/settings` that adds or removes `todo_write` from `defaultTools`. When
`defaultTools` is unset, the row writes the current default set plus `todo_write`, so
enabling one tool does not silently drop the others.

**Done when:** the settings test passes.

### RS.10: Verify and close

Run the full gates and CI required by `AGENTS.md`. Record every user-visible change
under `[Unreleased]` in `packages/coding-agent/CHANGELOG.md`. Set the spec's status to
Landed with a "Landed behavior" section, update the roadmap row, and delete this plan.

**Done when:** every prior row has a verified SHA, CI is green on three operating
systems, and the spec and roadmap carry the landed state in the closing commit.

## Order changes

None.

## Notes

RS.1, RS.2 to RS.3, and RS.4 have no dependencies and can land in any order. RS.6 and
RS.7 both depend on RS.5. RS.8 and RS.9 are independent of the mode work.

Every task follows the AGENTS.md test-first rule: write the failing test, watch it
fail for the right reason, then implement. Any test that drives a turn, writes a
session, or changes Git state changes into a scratch directory first.

Spec goal G7 applies to every task from RS.3 on: at least one test drives the
interactive mode or the component, not only `AgentSession`. That missing test is how
WS.6 was recorded as done without its mode adapters.
