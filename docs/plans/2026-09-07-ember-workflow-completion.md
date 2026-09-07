# Plan: Ember carried through the working session

**Status:** Not started. Awaiting approval to begin.

**Spec:** [`docs/specs/2026-09-07-ember-workflow-completion.md`](../specs/2026-09-07-ember-workflow-completion.md)

**Depends on.** Ember TUI surface `215801bfb`, overlay selector shape `3d852e842`, and frame-budget repair `1309e9ec9`.

## How to read this

Each task is one independently shippable change. Check a task only when its evidence exists, which means a test run, a rendered assertion, a benchmark number, or a commit SHA. Record the real SHA in the task table only after its check passes. No application code changes while this remains a plan.

Each task starts with a failing public-boundary test. Watch it fail for the right reason before writing the implementation. Run the focused check before starting the next task. Tests that drive a turn, write a session, or touch the evidence ledger `chdir` to a scratch directory first.

The tasks are ordered so the sequence proves itself. EMBER.1 corrects a false statement the product makes to users and is one constant. EMBER.2 through EMBER.5 are presentation only and each ships alone. EMBER.6 changes permission behavior and lands last, on a base the earlier tasks stabilized.

**Verification rule.** Tests alone are not sufficient verification. A task is verified only when its unit test, its rendered or live check, and its frame-budget check are complete.

## Task table

| ID | Task | State | Verification |
|---|---|---|---|
| EMBER.1 | Replace the "Always allow" label with a session-scoped one in the interactive responder, and decide the ACP surface. | implemented, focused checks green, SHA pending | `npx vitest run test/permissions/ test/acp/ --root packages/coding-agent`: 15 files, 237 tests pass. Four responder assertions and one ACP assertion were written first and watched fail against "Always allow". Both surfaces now read "Allow for this session". A gate test asserts the write is `{type: "addRules", destination: "session", rules: [{toolName: "read", behavior: "allow", ruleContent: "a.txt"}]}`, byte-identical to before, and that "Allow once" writes nothing. ACP `optionId` and `kind` are unchanged. `npx tsgo --noEmit` exits 0. |
| EMBER.2 | Route the two Apex-owned custom selectors through `paintBackground`, and give the session selector's border `borderMuted`. | not started | `npm --prefix packages/coding-agent test -- test/model-selector.test.ts test/extension-selector-search.test.ts test/session-selector-search.test.ts`. Each asserts the painted row or border in the emitted ANSI, not a palette token. The highlight hugs its text, matching `getSelectListTheme`. The session selector still passes an explicit color function. |
| EMBER.3 | Delete the mode-label prefix and carry mode in the caret's hue so the input origin holds still. | not started | `npm --prefix packages/coding-agent test -- test/custom-editor-chrome.test.ts`. The cursor column is identical in agent mode, in bash mode, and during a streaming turn. Bash mode is still legible from the caret hue and the tray. |
| EMBER.4 | Report hidden detail truthfully, render the hint only when detail is hidden, and add per-call expansion beside the global action. | not started | `npm --prefix packages/coding-agent test -- test/tool-execution-component.test.ts test/tool-execution-render-cache.test.ts`. A result hiding nothing renders no hint. Expanding one call leaves its siblings collapsed. The global action resets per-call overrides then applies its own value. Renderer invocation counts prove no renderer composes twice. A per-call toggle bumps `displayVersion` and invalidates the cache. |
| EMBER.5 | Move working status, elapsed time, and interrupt guidance into the footer's width ladder, and add the compaction hint. | not started | `npm --prefix packages/coding-agent test -- test/footer-width.test.ts test/footer-accessibility.test.ts test/footer-usage-cache.test.ts` at 120, 80, 56, 40, and 28 columns. Permission posture, the textual `!` and `!!` pressure markers, and the interrupt action survive every width. The tray does not invalidate cached usage totals. A custom-footer session keeps a visible working state. |
| EMBER.6 | Carry a bounded preview and an honest scope into the permission request, and carry denial guidance back through `GateDecision.reason`. | not started | `npm --prefix packages/coding-agent test -- test/permissions/`. Cases cover allow once, session rule, rule unavailable, cancel, guidance reaching the blocked tool result, an unavailable preview, and a concurrent in-place write between preview and apply. A rejection produces no execution and no evidence record. The preview reads only through the prepared operation. |

## Frame budget, for every task

`1309e9ec9` brought per-frame cost from 314 ms back under the 16 ms budget. Every task above renders, so every task can undo it.

- [ ] Record the trunk baseline first. `npx tsx packages/coding-agent/test/streaming-render-bench.ts` on `main`.
- [ ] Re-run at the task head, interleaved with the baseline.
- [ ] Fail the task if per-frame cost exceeds 16 ms or regresses against trunk.
- [ ] `npm --prefix packages/coding-agent test -- test/tui-flicker-red-loop.test.ts` stays green.

## Files and boundaries

Implementation files. `packages/coding-agent/src/modes/interactive/theme/theme.ts`, `src/modes/interactive/components/{model-selector,extension-selector,session-selector,custom-editor,tool-execution,footer}.ts`, `src/modes/interactive/interactive-mode.ts`, `src/core/permissions/{responder,gate}.ts`, `src/modes/acp/server.ts`, and a new `src/modes/interactive/components/permission-review.ts`.

Test files. `test/{model-selector,extension-selector-search,session-selector-search,custom-editor-chrome,tool-execution-component,tool-execution-render-cache,footer-width,footer-accessibility,footer-usage-cache}.test.ts`, `test/tui-flicker-red-loop.test.ts`, `test/streaming-render-bench.ts`, and `test/permissions/`.

Boundaries the owner may not cross. `pi-tui` and `pi-ai` stay unchanged, per ADR 0001. New state lives in Apex-owned components, not in the forked `interactive-mode.ts`, so the ADR 0003 merge budget holds. The preview producer never executes a tool and never opens a path the gate did not authorize, per ADR 0029. Display text never generates permission grammar, per ADR 0010. The render caches from `1309e9ec9` are preserved, not bypassed.

## Where the design reference is stale

The reference prototype predates `3d852e842`, `1309e9ec9`, and the v0.84.x merges. Four of its asks are declined on evidence. Do not implement them.

1. **Full-width selected row.** `SelectListTheme.selectedText` is typed `(text: string) => string` in frozen `pi-tui`, and `SelectList.renderItem` hands it a composed row with no width. The reference's own prose already records this. The target is the hug-the-text background, applied consistently.
2. **Background row in the settings selector.** `SettingsListTheme` is also frozen `pi-tui` and exposes separate `label` and `value` callbacks, each receiving only text. Painting them separately yields two fills with a gap. Settings keeps accent selection.
3. **Amber-only context pressure.** `footer.ts:252` already carries `!` past 70% and `!!` past 90% in text, so pressure survives a monochrome terminal. That is better than the reference. The compaction hint is added beside it, not instead of it.
4. **Three-row wordmark.** The reference's summary table asks for one. Its own Decision 00 rejects it and the shipped `apex-logo.ts` agrees. The table row is a stale revision.

Already landed, so out of scope. The dotted `borderMuted` overlay rule, the shared `paintBackground` selected row for every `SelectList`, the counted startup line, the branch row, `/resources`, the context gauge, and the `tool-panel.ts` lifecycle spine.

## Design decisions carried from the architecture review

1. **Component-owned state wins over a central presentation controller.** The rejected candidate introduced a `SessionPresentation` class owning composer view, tray view, disclosure state, and the pending prompt. It buys one predictable lifecycle. It costs a second authoritative state machine and a large rewrite of forked code that ADR 0003 charges against the merge budget.
2. **The losing candidate contributed the disclosure reset rule.** Its `DisclosureState` made the global action reset per-call overrides so its result stays predictable. Without it, a global expand after individual toggling produces a mixed transcript. EMBER.4 carries the rule.
3. **Neither candidate's preview fingerprint is built.** Both proposed a new content fingerprint compared at apply time. A replaced file already fails ADR 0029's identity comparison. A file edited in place already fails the edit tool's `old_string` match. A third mechanism on the security boundary buys no coverage.

## What EMBER.1 found

**The label was lying in two places, not one.** `gate.ts:91` writes the persisted rule with `destination: "session"`. Both the TUI responder and the ACP server presented "Always allow" for that same write.

**The ACP display name changed, its protocol ids did not.** `optionId: "allow-always"` is echoed back by the client and matched at `server.ts:143`, and `kind: "allow_always"` is the Agent Client Protocol's own enum. Only `name` is this codebase's to fix, so only `name` moved. The existing ACP test asserts `kind` and `optionId`, which is what made this safe.

**A second, separate defect surfaced and was left alone.** ACP offers "Reject always" and maps it to `{allow: false, persist: true}` at `server.ts:146`. The gate returns at `gate.ts:87` on any denial, before it reads `persist`, so no deny rule is ever written. That label promises persistence the code does not deliver, which is the same class of defect EMBER.1 exists to fix. It is not fixed here because the honest repair is to actually persist deny rules, and that is a behavior change with its own tests and its own risk. It needs its own task.

## Narrowed claims

1. **Preview coverage is partial by design.** Tools with no producer, binary files, and very large files render a truthful summary or an explicit unavailable reason.
2. **Custom renderers keep their behavior.** A renderer that does not report hidden detail gets an inspect affordance with no omitted-line count. `renderShell: "self"` is untouched.
3. **Custom footers migrate on opt-in.** They keep their separate working indicator until they adopt the tray input.
4. **The residual staleness case is a failed apply, not a wrong write.** EMBER.6 tests for it.
5. **Settings selection stays inconsistent with the other overlays.** This is a frozen-component limit, recorded rather than hidden. Anyone reading the screens will still see it.

## Verification evidence

- [x] EMBER.1 focused run. `test/permissions/` and `test/acp/`, 15 files, 237 tests pass. `npx tsgo --noEmit` exits 0. SHA still to record.
- [ ] EMBER.2 SHA and the three selector test outputs.
- [ ] EMBER.3 SHA and the cursor-column test output.
- [ ] EMBER.4 SHA and both tool-execution test outputs.
- [ ] EMBER.5 SHA and the three footer test outputs at all five widths.
- [ ] EMBER.6 SHA and the full `test/permissions/` run.
- [ ] Trunk and head numbers from `streaming-render-bench.ts` for every task.
- [ ] One live run of the real TUI driving the whole journey. Type a task, watch it work, take an approval prompt, inspect a change, read the result. Capture the screens under `.apex-code/`.
- [ ] `npx tsgo --noEmit` exits 0.
- [ ] `npm test` green once per completed slice, and `npm run check` before close.
- [ ] Forked-file hunk count recorded in `docs/upstream-log.md`.

## Exit conditions

- Every task row has a focused green check and a verified commit SHA.
- The frame-budget numbers are recorded, because the last TUI work in this area was a performance repair and this work renders on the same path.
- The live journey run is captured, because a passing palette suite beside a visible inconsistency is the failure that motivated this work.
- `npm run check` passes, including `check:docs`.
- Durable decisions are promoted into the spec or an ADR before this plan is deleted.
- This plan is deleted on completion, not archived in place. Git keeps it.
