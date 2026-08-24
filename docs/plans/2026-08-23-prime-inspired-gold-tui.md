# Plan: Prime-inspired gold TUI

**Status:** Active — PGT.1 complete; PGT.2 in progress

**Spec:** [`docs/specs/2026-08-23-prime-inspired-gold-tui.md`](../specs/2026-08-23-prime-inspired-gold-tui.md)

## Task table

| ID | Task | State | Commit |
| --- | --- | --- | --- |
| PGT.1 | Establish the gold-neutral theme contract | Done — narrow test and TypeScript verified | `ba0826af3` |
| PGT.2 | Replace the bordered composer with the borderless slab | In progress | — |
| PGT.3 | Enforce the Prime-like safety tray hierarchy | Not started | — |
| PGT.4 | Render generic tool executions as flat filled panels | Not started | — |
| PGT.5 | Verify the integrated TUI and close documentation | Not started | — |

## PGT.1 — Establish the gold-neutral theme contract

1. Add failing assertions to `packages/coding-agent/test/apex-theme.test.ts` for the canonical gold, neutral, semantic, selection, composer, and tool variables and their public token mappings.
2. Run `npm --workspace packages/coding-agent test -- apex-theme.test.ts` and confirm failure identifies the old teal palette.
3. Update `packages/coding-agent/src/modes/interactive/theme/apex.json` to the approved values without adding a second theme schema or changing `dark.json`/`light.json`.
4. Re-run the narrow theme test, then `npx tsgo --noEmit`.
5. Commit implementation and the plan-row state together; verify the SHA with `git cat-file -t` before recording it.

## PGT.2 — Replace the bordered composer with the borderless slab

1. Rewrite the public-boundary expectations in `packages/coding-agent/test/custom-editor-chrome.test.ts` for a three-row borderless filled slab, two-cell normal inset, local narrow degradation, cursor/background repair, and autocomplete separation.
2. Run the narrow test and confirm it fails on the inherited editor borders/one-cell inset.
3. Update `packages/coding-agent/src/modes/interactive/components/custom-editor.ts` using the smallest Apex-owned rendering change. Preserve the inherited editor state machine, width semantics, hardware cursor marker, reverse-video cursor, mode prompt, placeholder, command tint, autocomplete, and extension replacement.
4. Update only the necessary construction options in `packages/coding-agent/src/modes/interactive/interactive-mode.ts` if the surface contract changes.
5. Run the custom-editor suite, `npx tsgo --noEmit`, and `git diff -- packages/tui`.
6. Commit implementation and the plan-row state together; verify and record the SHA.

## PGT.3 — Enforce the Prime-like safety tray hierarchy

1. Add failing boundary cases to `packages/coding-agent/test/footer-width.test.ts` and `packages/coding-agent/test/footer-accessibility.test.ts` proving that every non-default permission mode is the first surviving datum at all widths, `bypassPermissions` is never displaced, default mode yields the narrow tray to context, textual pressure markers remain, and every row is width-safe.
2. Run both footer suites and confirm the failures expose current routine-telemetry competition or ordering.
3. Refactor only the compact branch of `packages/coding-agent/src/modes/interactive/components/footer.ts` into independently budgeted safety-first segments. Preserve the explicit full-detail mode and existing data calculations.
4. Run the footer suites, then the relevant interactive-layout tests and `npx tsgo --noEmit`.
5. Commit implementation and the plan-row state together; verify and record the SHA.

## PGT.4 — Render generic tool executions as flat filled panels

1. Add failing public rendering assertions to `packages/coding-agent/test/tool-execution-component.test.ts` for full-width state backgrounds, textual `label · state`, a filled separator row, two-cell content inset with narrow degradation, and width safety.
2. Run the narrow tool suite and confirm it fails on the current bordered shell.
3. Implement the panel in Apex-owned component code, extracting a focused component only if it reduces the existing renderer's conditional load. Reuse `toolPendingBg`, `toolSuccessBg`, and `toolErrorBg`; do not expand the theme schema solely for this shell.
4. Preserve specialized renderers, expansion behavior, elapsed time, diffs, images, and explicit error text.
5. Run the narrow suite, related tool/render regression tests, `npx tsgo --noEmit`, and the frozen-package diff.
6. Commit implementation and the plan-row state together; verify and record the SHA.

## PGT.5 — Verify the integrated TUI and close documentation

1. Run the Impeccable detector once over the changed TUI targets and resolve actionable findings without weakening the approved Prime/gold direction.
2. Build and run a local interactive smoke render. Confirm composer/tray/tool hierarchy, gold palette, and visible permission posture at normal and constrained widths.
3. Run `npm run check`.
4. Run the narrow theme, composer, footer, tool, splash, and interactive-layout suites.
5. Run `npm --workspace packages/coding-agent test`.
6. Run root `npm test`.
7. Confirm `git diff -- packages/tui` is empty and `git diff --check` is clean.
8. Update the spec verification section and roadmap with verified results and real SHAs.
9. Delete this completed plan, commit the closure, and verify the closure SHA.

## Order changes

- The plan originally named `npm run typecheck`, but the monorepo exposes no such script. PGT.1 caught the stale command after its narrow test passed; all slices now name the repository's actual TypeScript gate, `npx tsgo --noEmit`.
