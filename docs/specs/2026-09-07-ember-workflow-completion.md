# Spec: Ember carried through the working session

**Status:** Draft

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Created | `2026-09-07` |
| Last updated | `2026-09-07` |
| Roadmap phase | `none — product-surface follow-up` |
| Tracking issue/PR | `none` |
| Compatibility posture | `Preserves compatibility, with two deliberate breaks. See below.` |

**Compatibility posture.** The presentation changes preserve compatibility. Custom
editors, custom footers, extension working-indicator controls, and the
`renderShell: "self"` renderer contract keep their current behavior. One break is
deliberate. The interactive permission prompt stops offering "Always allow" and offers
a session-scoped label instead. The label is the only thing that changes. The rule the
gate writes is identical, because the tool's own `ruleForCall()` still generates it. No
session file, settings key, or CLI flag changes shape, so nothing a user has on disk
stops working.

The second break is an API removal. `CustomEditor` is exported at `src/index.ts:395`,
so its `setModeLabel` was public. It is deleted rather than left as a no-op, and
`setPromptMode` replaces it. A no-op would let an extension keep calling a method that
silently does nothing, where a removal fails at build time for a TypeScript consumer.
An extension that called `setModeLabel` must move to `setPromptMode`, whose argument is
a closed `PromptMode` union rather than a free string.

## Executive summary

The Ember design reached the launch screen, the palette, the tool spine, and the shared
overlay selector. It did not reach the composer's geometry, per-call tool disclosure,
the working-status tray, or the permission prompt. This spec completes those four, and
corrects a permission label that overstates what it grants. It deliberately does not
chase two things the design reference asks for, because the current code is right and
the reference is stale.

## Context and motivation

- `docs/specs/2026-08-25-ember-tui-surface.md` is the design this completes.
- The design reference is the `Apex Code Ember` prototype, authored before commits
  `3d852e842`, `1309e9ec9`, and the v0.84.x upstream merges. It is a snapshot, not a
  current statement of the codebase. Where the two disagree, this spec says which wins
  and why.
- `docs/adr/0001-fork-boundary.md` freezes `pi-tui`. Two of the reference's asks are
  unreachable without breaking that freeze. See Non-goals.
- `docs/adr/0029-prepared-path-operation.md` governs the permission preview. A preview
  reads through the prepared operation the gate already authorized. It never re-derives
  a target from the original arguments.
- `docs/adr/0010` governs rule authorship. The gate writes rules from the tool's
  `ruleForCall()`. Display text never generates permission grammar.
- `docs/adr/0003-upstream-merge-cadence.md` caps the merge cost of edits to forked
  files. `interactive-mode.ts` is forked, so new state stays out of it.
- `docs/roadmap.md` § Explicitly not building rules out a second TUI stack.

## Current state

Commit `3d852e842` already delivered more of the reference than the reference itself
records. Commit `1309e9ec9` then added a render-cache and frame-budget regime that any
new work has to live inside.

**Already landed. Not in scope.**

- `components/dynamic-border.ts` defaults to a dotted `┄` rule in `borderMuted`. The
  reference's "quiet overlay rule" shipped.
- `theme/theme.ts:1360` paints the shared selected row with a background step through
  `paintBackground`. Every list built on `SelectList` gets it, the command palette and
  file picker included.
- The counted startup line, the branch row, `/resources`, the context gauge, and the
  `tool-panel.ts` lifecycle spine all shipped.

**Diverging, and in scope.**

- `components/model-selector.ts:405` and `components/extension-selector.ts:89` compose
  their own rows and paint the selected one with `theme.fg("accent", ...)`. Both are
  Apex-owned renderers, so both can route through `paintBackground`.
- `components/session-selector.ts:738` passes `theme.fg("accent", s)` into
  `DynamicBorder`, overriding the quiet default. The explicit color function is
  required, because `dynamic-border.ts` documents that extension-loaded components must
  pass one to survive the jiti module cache. Only the color is wrong.
- `components/custom-editor.ts:199` builds the prompt as
  `` `[${this.modeLabel}] ${this.promptPrefix}` `` and feeds it to `visibleWidth`.
  `interactive-mode.ts:4394` sets that label to `bash` or `busy`, so entering bash mode
  or starting a turn moves the input origin sideways.
- `components/tool-execution.ts:298` renders the expand hint whenever a result exists
  and is not expanded, never asking whether anything is hidden. The fallback renderer at
  line 174 gets this right and prints a count only when lines remain.
- `interactive-mode.ts:3485` broadcasts one `toolOutputExpanded` boolean to every
  component. `tool-execution.ts:255` already stores per-call `expanded` state that
  nothing sets individually.
- `core/permissions/responder.ts:20` offers "Always allow". Line 11 records that it
  persists a session-source rule.

**Constraints the perf work imposes.** `ToolExecutionComponent` caches composed lines
against `renderCacheKey()`, which is `displayVersion:lifecycle:durationKey`.
`setExpanded` calls `updateDisplay`, which increments `displayVersion`, so per-call
expansion invalidates correctly as long as it routes through `setExpanded`.
`FooterComponent` caches usage totals against the session entry version. The frame
budget is 16 ms, measured by `test/streaming-render-bench.ts`, and
`test/tui-flicker-red-loop.test.ts` guards the regression.

All of this is Apex Code's own work, not upstream Pi behavior.

## The problem

A user meets Ember on the launch screen and in the command palette, then spends every
following hour on surfaces that do not follow it.

The composer moves. Pressing the bash key shifts the caret and every character right of
it. Starting a turn does it again with `busy`. The reference asks for a frame that stays
put and a caret that changes hue instead.

Disclosure lies. A completed tool call with three lines of output and nothing hidden
still advertises a key that reveals nothing. Pressing it expands the entire transcript,
because expansion is global.

Two pickers disagree with the rest. `/model` and the extension picker paint selected
text in the accent while every `SelectList` overlay lights a background row.

The permission label overstates its grant. A user reading "Always allow" has been told
the choice is permanent. It lasts until the session ends. The prompt also shows no
preview of the change it is authorizing, and a rejection carries no instruction back.

`test/apex-theme.test.ts` passes twelve cases while the selector divergence is visible
on screen. The tests assert palette tokens. The divergent renderers never consult the
tokens.

## Goals

- [ ] `/model` and the extension picker light their selected row with the same
      `paintBackground` treatment `getSelectListTheme` uses, proved by a rendered-output
      test rather than a token assertion.
- [ ] Overlay borders read as the quiet dotted rule everywhere, including the session
      selector, without dropping the explicit color function jiti requires.
- [ ] The composer's input origin stays at the same column across idle, typing, bash,
      working, and context pressure, proved by a cursor-column test.
- [ ] Bash mode is legible from the caret's hue and the tray, not from a label that
      moves the input.
- [ ] A completed tool call with nothing hidden renders no disclosure hint.
- [ ] Expanding one tool call leaves every other call unchanged, and the global expand
      action still expands everything.
- [ ] The permission prompt names the scope it actually grants, and lets a rejection
      carry guidance into the blocked tool result.
- [ ] The prompt shows the proposed change before the user chooses. **Deferred.**
      `ExtensionSelectorComponent` draws its title as one accent-bold `Text` and
      `select` offers no other channel, so this needs either a new review component or
      a new extension UI primitive. The roadmap rules out a second TUI stack, so which
      of those is acceptable is a design decision and gets its own spec.
- [ ] The context tray keeps its textual pressure markers and gains an actionable
      compaction hint.
- [ ] `pi-tui` and `pi-ai` are unchanged, per-frame cost stays inside the 16 ms budget,
      and the forked-file hunk count is recorded in `docs/upstream-log.md`.

## Non-goals

Two of these decline something the design reference asks for. Both are cases where the
current code is right and the reference is stale.

- [ ] **No full-width selected row.** The reference's mock paints the highlight edge to
      edge. Its own prose already corrects this, and the code confirms it.
      `SelectListTheme.selectedText` is typed `(text: string) => string` in frozen
      `pi-tui`, and `SelectList.renderItem` hands it a composed row with no width. A
      full-width highlight needs a `pi-tui` patch, which ADR 0001 forbids. The target is
      the hug-the-text background the shared theme already produces, applied
      consistently.
- [ ] **No background row in the settings selector.** `SettingsListTheme` is also frozen
      `pi-tui`, and it exposes separate `label` and `value` callbacks, each receiving
      only text. Painting them separately yields two fills with a gap between, which
      reads worse than the accent text there now. Settings keeps accent selection until
      the component itself is replaced, and that is not this spec.
- [ ] **No colour-only context pressure.** The reference asks for amber past 75%.
      `footer.ts:252` already carries `!` past 70% and `!!` past 90% in text, so pressure
      survives a monochrome terminal and a colour-blind reader. That is better than the
      reference and it stays. The compaction hint is added beside it, not instead of it.
- [ ] **No three-row wordmark.** The reference's summary table asks for one. Its own
      Decision 00 rejects it, and the shipped `apex-logo.ts` agrees. The table row is a
      stale revision.
- [ ] **No new presentation state machine.** A central session controller was designed
      and rejected. It adds a second authoritative source of state and rewrites large
      parts of forked `interactive-mode.ts`, which ADR 0003 charges against the merge
      budget.
- [ ] **No scrollable transcript viewport.** Tool inspection uses an overlay.
- [ ] **No new permission fingerprint mechanism.** See Risks.
- [ ] **No change to rule grammar or gate precedence.**

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Selected row | Route the two Apex-owned custom renderers through `paintBackground`, matching `getSelectListTheme`. Pass `borderMuted` to the session selector's `DynamicBorder`, keeping an explicit function. | `components/model-selector.ts`, `components/extension-selector.ts`, `components/session-selector.ts` |
| Composer prompt | Delete the `[label]` prefix. Carry mode in the caret's hue, ember for agent and the `bashMode` token for bash, so `visibleWidth` is constant. | `components/custom-editor.ts`, `interactive-mode.ts` |
| Tool disclosure | Report whether detail is hidden and render the hint only then. Add per-call toggling through the existing `setExpanded`. | `components/tool-execution.ts`, `interactive-mode.ts` |
| Activity tray | Move working status, elapsed time, and interrupt guidance into the footer's existing width ladder, reusing the existing elapsed timer. | `components/footer.ts`, `interactive-mode.ts` |
| Context hint | Add an actionable compaction hint beside the existing textual pressure markers. | `components/footer.ts` |
| Permission review | Carry an honest scope into the request and optional guidance back on a denial, both over the existing `select` and `input` primitives. | `core/permissions/responder.ts`, `core/permissions/gate.ts`, `modes/acp/server.ts` |

**Disclosure state.** Per-call toggling sets `expanded` through `setExpanded`, which
calls `updateDisplay` and increments `displayVersion`, so the render cache invalidates
by construction. The global action keeps its meaning by resetting every per-call
override before applying its own value, so the global result stays predictable after any
amount of individual toggling.

**Hidden-detail reporting.** The component must not run a renderer twice to compare
expanded output against collapsed output, because a renderer may be stateful and because
a second composition would double the per-frame cost the cache exists to remove.
Built-in renderers report hidden detail through the Apex-owned render context. A
renderer that does not report keeps its current behavior and gets an inspect affordance
with no line count.

**Activity tray.** `ToolExecutionComponent` already owns an elapsed timer with
`startElapsedTimer` and `stopElapsedTimer`. The tray reuses that cadence rather than
adding a second interval, and it must not invalidate the footer's cached usage totals,
which are keyed to the session entry version. A tray that re-rendered usage every second
would undo `1309e9ec9`.

**Permission preview.** The preview producer sits with tool presentation, not with the
gate. It runs only after the gate has decided to ask. It reads through the
`PreparedPathOperation` that authorization already validated, so it cannot resolve a
different target and cannot create a read the gate did not authorize. Binary files,
large files, and tools with no producer fall back to a truthful summary or to
`{ kind: "unavailable", reason }`. The preview never executes the tool.

**Session scope.** The prompt offers a session choice only when `ruleForCall()` returns
a persistable rule. When it returns `null`, as `ask-user` does, the choice is absent
rather than shown and rejected. The gate still generates and writes the rule.

**Denial guidance.** Guidance is trimmed and length-bounded at the UI boundary, then
travels in the existing `GateDecision.reason` at `gate.ts:41`. The agent loop already
turns a blocked decision into an error tool result, so no second message queue appears.

**Migration.** Changing `PermissionAnswer` touches every responder. The ACP responder at
`modes/acp/server.ts:32` and the configured-command consumers migrate in the same wave,
and the old shape is deleted in that wave rather than left beside the new one.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| Variable-width `[${modeLabel}]` prompt prefix, `custom-editor.ts:199` | code | removed, superseded by a fixed-width per-mode marker |
| `CustomEditor.setModeLabel`, public through `src/index.ts:395` | code | removed, superseded by `setPromptMode(mode: PromptMode)` |
| The `busy` prompt label set at `interactive-mode.ts:4394` | behavior | removed. `WorkingStatusIndicator` already carried that signal, so nothing is lost before the tray work lands |
| Unconditional disclosure hint, `tool-execution.ts:298` | behavior | removed, replaced by a hint conditioned on hidden detail |
| Accent-only selected row, `model-selector.ts:405` and `extension-selector.ts:89` | code | superseded by `paintBackground` |
| Accent border argument, `session-selector.ts:738` | code | superseded by `borderMuted`, the argument itself retained |
| `ALWAYS_ALLOW = "Always allow"`, `responder.ts:20` | behavior | superseded by a session-scoped label |
| Separate working-status placement above the editor | code | retired once the footer tray carries activity and custom-footer sessions have a verified path |
| Global-only `toolOutputExpanded` broadcast, `interactive-mode.ts:3485` | behavior | retained as the global action, no longer the only way to expand |

Retained deliberately. `getSettingsListTheme`'s accent selection stays, because the
frozen component cannot carry a row background. The textual context-pressure markers
stay. Global expansion keeps its keybinding. The public renderer APIs and
`renderShell: "self"` keep their contract. The render caches added by `1309e9ec9` stay.

## Risks

**A preview goes stale while the user is deciding.** Two existing checks already bound
this, which is why no new mechanism is added. A replaced file fails ADR 0029's
`O_NOFOLLOW` open and `fstat` identity comparison. A file edited in place fails the edit
tool's `old_string` match against re-read content, so the tool errors instead of writing
something the user did not see. The residual case is a preview that looks right and a
call that then fails. The signal is an edit error immediately after an approval.

**The tray reintroduces the flicker `1309e9ec9` fixed.** An elapsed display that
invalidates the footer every second, or a hidden-detail check that composes twice, would
push per-frame cost back over budget. The signal is
`test/streaming-render-bench.ts` regressing against its trunk baseline, and
`test/tui-flicker-red-loop.test.ts` going red.

**A stateful custom renderer is called twice and misreports.** The signal is a
duplicated side effect or a wrong omitted-line count in
`tool-execution-render-cache.test.ts`, which asserts renderer invocation counts.

**A custom footer loses activity during migration.** Custom footers keep their existing
separate indicator until they opt into the tray input.

**The forked-file diff grows past the merge budget.** New state lives in Apex-owned
components, and the hunk count goes into `docs/upstream-log.md` before close.

## Verification

Test-first, per `AGENTS.md`. Each test is written, run, and watched to fail for the
right reason before its implementation exists.

- Selection. Extend `test/model-selector.test.ts` and
  `test/extension-selector-search.test.ts` to assert the painted row in the emitted
  ANSI, not a palette token. A separate assertion covers the session selector's border
  rendering in `borderMuted`.
- Composer. Extend `test/custom-editor-chrome.test.ts` with a cursor-column assertion
  across agent mode, bash mode, and a streaming turn.
- Disclosure. Extend `test/tool-execution-component.test.ts` with a result that hides
  nothing and one that hides lines. Extend `test/tool-execution-render-cache.test.ts`
  with renderer invocation counts and a cache-invalidation case for per-call expansion.
- Tray. Extend `test/footer-width.test.ts` and `test/footer-accessibility.test.ts` at
  120, 80, 56, 40, and 28 columns. Permission posture, the textual pressure marker, and
  the interrupt action survive every width. Extend `test/footer-usage-cache.test.ts` to
  prove the tray does not invalidate cached usage totals.
- Permissions. Extend `test/permissions/` with allow once, session rule, rule
  unavailable, cancel, denial guidance reaching `GateDecision.reason`, an unavailable
  preview, and a concurrent in-place write between preview and apply. Assert that a
  rejection produces no execution and no evidence record.
- Perf. Run `npx tsx packages/coding-agent/test/streaming-render-bench.ts` at trunk
  first, then at the head, interleaved. Per-frame cost stays inside 16 ms and does not
  regress against the trunk baseline.
- Session-driving tests `chdir` to a scratch directory first, per `AGENTS.md`.
- Gates. `npx tsgo --noEmit` during TypeScript work, the narrowest relevant test file
  before broadening, `npm test` once per completed slice, and `npm run check` before
  close.
- Live. Run the real TUI and drive one full journey. Type a task, watch it work, take an
  approval prompt, inspect a change, read the result.

## Rollout

Needs `docs/plans/2026-09-07-ember-workflow-completion.md`, because the work spans six
independently shippable slices, one of which changes permission behavior and needs its
own status tracking.

No ADR is written up front. The rejected central controller and the two declined
reference asks are recorded in Non-goals with their reasoning. If the controller question
re-opens during implementation, or if the preview seam turns out to need a change to the
gate's contract, that decision earns an ADR and is cited here.
