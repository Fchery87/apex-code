# Plan: Make built features reachable from the terminal

**Status:** In progress. RS.1 through RS.9 are implemented in verified commit bc0ac1b0d47ed9a77ffe2e9af9b6564fafd1d67b. Full local gates and actual terminal checks passed. RS.8 still needs idle-host timing verification. Three-OS CI passed at c010d923904d13930a3d12faa03f9fa990f5d21a. RS.10 awaits idle-host timing verification and phase closure. The user authorized commit, push, merge, and the following release on 2026-10-04.

**Spec:** [Make built features reachable from the terminal](../specs/2026-10-03-reachable-harness-surfaces.md)

## Tasks

| # | Task | State | SHA | Verified by |
| --- | --- | --- | --- | --- |
| RS.1 | Correct the WS.6 and Phase 6 records (G6) | Done | bc0ac1b0d47ed9a77ffe2e9af9b6564fafd1d67b | `node scripts/validate-docs-lifecycle.mjs .` passed on 2026-10-03. The workspace-state amendment and Phase 6 qualification are in place. Completion commit and SHA verified with `git cat-file -t`. |
| RS.2 | Add `AgentSession.previewTreeWorkspace()` (G1) | Done | bc0ac1b0d47ed9a77ffe2e9af9b6564fafd1d67b | Preview cases cover all four states, disabled checkpoints, and unavailable or throwing comparison. Files, checkpoint refs, session entries, session file, and leaf stay unchanged. The final three-file tree run passed 37 tests on 2026-10-03; `npx tsgo --noEmit` exited 0. Completion commit and SHA verified with `git cat-file -t`. |
| RS.3 | Ask before restoring files in `/tree`; pass `workspacePolicy` through the extension `navigateTree` (G1) | Done | bc0ac1b0d47ed9a77ffe2e9af9b6564fafd1d67b | The final three-file tree run passed 37 tests; the extension suite passed 55 tests on 2026-10-03. The real selector handler covers preview states, all choices, outcome text, and compaction races. Scratch Git tests prove restore, keep, and cancel. A manual source CLI run confirmed these choices, no prompt on a matching or missing checkpoint, and a pre-restore ref containing the original edits. Full `npm test` and `npm run check` exited 0. Completion commit and SHA verified with `git cat-file -t`. |
| RS.4 | Show `Worked for` / `Interrupted after` after each turn (G5) | Done | bc0ac1b0d47ed9a77ffe2e9af9b6564fafd1d67b | The duration, compaction, and retry suites passed 23 tests on 2026-10-03; `npx tsgo --noEmit` exited 0. Tests cover both labels, the one-second threshold, multi-step and retry timing, typed retry cancellation, and unchanged session entries and model context. A scratch source CLI displayed `Worked for 1s` and `Interrupted after 7s`; neither appeared in its session JSONL. Full `npm test` and `npm run check` exited 0. Completion commit and SHA verified with `git cat-file -t`. |
| RS.5 | Implement the interactive mode layer in the permission core (ADR 0037) | Done | bc0ac1b0d47ed9a77ffe2e9af9b6564fafd1d67b | All permission tests plus policy authorization and delegation end-to-end passed 329 tests across 18 files on 2026-10-03; `npx tsgo --noEmit` exited 0. New boundary tests prove source precedence, tool and command enforcement, live delegated-child changes, unchanged persisted state and rules, startup bypass ceiling, custom SDK fallback, clear/reload races, and fresh/resumed reset. Full `npm test` and `npm run check` exited 0. Completion commit and SHA verified with `git cat-file -t`. |
| RS.6 | Bind Shift+Tab to `app.permissionMode.cycle`, move `app.thinking.cycle` to `alt+t`, show the session marker in the footer (G2) | Done | bc0ac1b0d47ed9a77ffe2e9af9b6564fafd1d67b | Nine focused files passed 146 tests on 2026-10-03; TypeScript and `npm run check` exited 0. Tests cover defaults without collisions, extension reservation, normal and startup-bypass cycles, rapid presses, reload/replacement races, failed-reload footer recovery, narrow footer markers, custom binding hints, and shadowed settings. The source CLI confirmed both keys, mode origins, reload reset, and one-time hint persistence without mode persistence. Package README and keybinding docs include the rebinding path. Full `npm test` exited 0. Completion commit and SHA verified with `git cat-file -t`. Independent RS.6 review could not finish because of the agent usage limit; root review is complete. |
| RS.7 | Inject a `PlanPresenter` into `plan_present`; switch mode on approval; activate `plan_present` with plan mode (G3) | Done | bc0ac1b0d47ed9a77ffe2e9af9b6564fafd1d67b | Three focused files passed 73 tests on 2026-10-03; TypeScript exited 0. Tests cover all choices, evidence, actual edit authorization and provider continuation, explicit and automatic loadouts, restrictive registries, hook scope, resume/tree restoration, stale approvals, and asynchronous mode reads. The startup regression plus plan approval passed 48 tests after the startup fixture began awaiting the public settled event in scratch cwd. The source CLI confirmed both approval modes, rejection, Escape, footer updates, and reload reset without mode persistence. Independent RS.7 correctness review found no remaining blocking findings. Full `npm test` and `npm run check` exited 0. Completion commit and SHA verified with `git cat-file -t`. |
| RS.8 | Render the pinned task panel, `/tasks`, `app.tasks.toggle`, and the compact `todo_write` cell (G4) | Done, unverified | bc0ac1b0d47ed9a77ffe2e9af9b6564fafd1d67b | Final feature checks passed 25 tests across four files; the earlier related run passed 153 tests across eight files before the final mounted settlement case. TypeScript exited 0. Component/mode/SDK tests cover bounded rows, cached snapshots, actual loadouts and hooks, tree/resume/compaction, persistence, command/key routing and reservation, extension widgets, completion/retry settlement, and compact tool result/error/disclosure. The source CLI confirmed Alt+J, /tasks, compact results, Ctrl+O disclosure, completion and clearing, and resumed expansion. Independent review found no blocking findings. A 24-case mounted benchmark proved zero unchanged-frame branch reads and bounded panel rows; timings were contaminated by host activity. Full `npm test` and `npm run check` exited 0 on the final source snapshot. Completion commit and SHA verified with `git cat-file -t`; idle-host timing remains pending. |
| RS.9 | Add a `/settings` row that adds or removes `todo_write` from `defaultTools` (G4) | Done | bc0ac1b0d47ed9a77ffe2e9af9b6564fafd1d67b | `test/task-tool-defaults.test.ts` drives the mounted row across eight scenarios. Final feature checks passed 25 tests across four files; TypeScript exited 0. The source CLI preserved the four core defaults on enable, activated the task tool in a new session, restored expanded rows on resume, and retained the current panel when disabled. Independent review found no blocking findings. Full `npm test` and `npm run check` exited 0 on the final source snapshot. Completion commit and SHA verified with `git cat-file -t`. |
| RS.10 | Phase verification and close | In progress | — | Final `npm run check` exited 0, including TypeScript, after checking 1195 files with no fixes. Full `npm test` exited 0 on 2026-10-04. Coding-agent reported 455 passed files and 4192 passed tests, with six skipped files and 51 skipped tests. Agent-core passed 975 tests and scrubber passed 21 tests; root scripts passed 216 with no failures. Actual terminal checks and independent review passed. Paired transcript and mounted panel benchmarks exited 0, but host contention prevents idle-host timing evidence. Completion source SHA is verified. [CI](https://github.com/Fchery87/apex-code/actions/runs/37191806521) passed the frozen-package, Linux, macOS, and Windows jobs at `c010d923904d13930a3d12faa03f9fa990f5d21a`. Idle-host timing verification remains missing. `[Unreleased]` documents the user-visible behavior and thinking-key rebinding. Spec and plan remain open until closure requirements pass. |

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
in-progress item; expanded shows up to five items and `+N more`. Hide a newly completed list after the whole run settles, including retries. Add `/tasks` and `app.tasks.toggle`; Use the reserved `app.tasks.toggle` action with Alt+J, as recorded in the spec. Save the
expanded state as a global setting. Render the `todo_write` tool cell as
`Task list updated · N/M complete`.

**Done when:** the panel tests pass and the render bench shows no regression beyond
contamination, measured as AGENTS.md describes.

### RS.9: Settings row

Add a row to `/settings` that adds or removes `todo_write` from `defaultTools`. When
`defaultTools` is unset, seed it from the session construction defaults plus
`todo_write`. Preserve configured services and explicit arrays. Project-controlled
defaults are read-only. The row affects new sessions; current tools and reload
retain their selection. CLI restrictions keep precedence.

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

The first batch passed `npm test` on 2026-10-03. Agent-core reported 81 files and
975 tests passed, with one test skipped. Coding-agent reported 447 files and
4,065 tests passed, with six files and 51 tests skipped. `npm run check` exited 0,
including TypeScript and documentation validation. The implementation remains
uncommitted because poteto-mode's required pre-commit `deslop` plugin is unavailable.
RS.1 through RS.3 retain `Done, unverified` until completion commits provide real SHAs.

The second batch passed full `npm test` on 2026-10-03. Agent-core reported 81 files
and 975 tests passed, with one test skipped. Coding-agent reported 450 files and
4,120 tests passed, with six files and 51 tests skipped. `npm run check` exited 0,
reporting `Checked 1187 files in 12s. No fixes applied.` Documentation lifecycle
validation passed. RS.4 through RS.6 retain `Done, unverified` until completion
commits provide real SHAs. The final command output and earlier failing runs are
recorded under `.apex-code/verification/reachable-surfaces/`.

The third batch passed full `npm test` on 2026-10-03. Agent-core reported 81 files
and 975 tests passed, with one test skipped. Coding-agent reported 451 files and
4,165 tests passed, with six files and 51 tests skipped. `npm run check` exited 0,
reporting `Checked 1188 files in 18s. No fixes applied.` Documentation lifecycle
validation passed. The preceding full run exposed a startup test that awaited
core-agent idle before session preparation had finished. The test now awaits the
public `agent_settled` event and uses scratch cwd; its ordering and message assertions
remain intact. Production code did not change for that repair. RS.7 retains
`Done, unverified` until a completion commit provides a real SHA. Final outputs,
the failing run, terminal transcripts, and review artifacts are recorded under
`.apex-code/verification/reachable-surfaces/`.

RS.1, RS.2 to RS.3, and RS.4 have no dependencies and can land in any order. RS.6 and
RS.7 both depend on RS.5. RS.8 and RS.9 are independent of the mode work.

Every task follows the AGENTS.md test-first rule: write the failing test, watch it
fail for the right reason, then implement. Any test that drives a turn, writes a
session, or changes Git state changes into a scratch directory first.

Spec goal G7 applies to every task from RS.3 on: at least one test drives the
interactive mode or the component, not only `AgentSession`. That missing test is how
WS.6 was recorded as done without its mode adapters.

The implementation is committed at `bc0ac1b0d47ed9a77ffe2e9af9b6564fafd1d67b` (`git cat-file -t` returned `commit`). The user explicitly requested commit and release after the unavailable pre-commit skill was reported. Direct diff review and normal repository hooks ran; the missing skill was not claimed as executed. Three-OS CI passed at `c010d923904d13930a3d12faa03f9fa990f5d21a` in [run 37191806521](https://github.com/Fchery87/apex-code/actions/runs/37191806521). The final committed PR head must also pass the required checks before merge. Phase closure remains separate from release publication while idle-host timing is unresolved.
