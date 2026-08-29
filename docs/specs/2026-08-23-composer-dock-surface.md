# Spec: Composer dock surface

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | `Apex Code` |
| Created | `2026-08-23` |
| Last updated | `2026-08-23` |
| Roadmap phase | `product-surface follow-up after Phase 12` |
| Tracking issue/PR | `none` |
| Compatibility posture | The prompt text, cursor behavior, editor settings, autocomplete behavior, and extension editor replacement remain compatible. `packages/tui` remains byte-identical. |

## Summary

The lower prompt dock must render the composed input surface agreed in the terminal-interaction-polish design. The editor block gains a low-contrast Apex-owned background, one cell of outer padding on every side, and full-width background coverage around the cursor. The autocomplete panel stays separate from the filled editor block.

## Context

The terminal-interaction-polish work implemented lifecycle cards, the responsive tray, bounded errors, activity labels, delegation summaries, contextual hints, and `/config`. It deliberately left the filled editor surface out because the earlier implementation treated it as unsupported by the inherited editor API.

That conclusion was too narrow. `CustomEditor` already owns the prompt prefix and post-processes the inherited editor output. It can compose the surface without changing `packages/tui`, provided that it preserves ANSI cursor handling and the editor's width calculations.

## Goals

- [x] Render the default prompt editor as a quiet, filled surface using the existing `userMessageBg` token.
- [x] Add one cell of horizontal and vertical breathing room around the editor block when width permits.
- [x] Keep the prompt prefix, placeholder, command tint, cursor marker, reverse-video cursor cell, wrapping, and narrow-width fallback intact.
- [x] Keep autocomplete outside the filled editor surface.
- [x] Leave selectors, extension input, and extension editor replacement behavior unchanged.
- [x] Keep `packages/tui` unchanged.

## Non-goals

- Changing the Apex palette, startup screen, placeholder text, or the responsive status tray.
- Replacing editor focus, bash, thinking, warning, or error semantics.
- Adding a new setting for the composer surface.
- Patching, vendoring, or otherwise changing `packages/tui`.

## Design

`CustomEditor` receives a surface renderer through its constructor options. When present and the terminal can fit the padded editor, it renders the inherited editor at the reduced inner width, then adds one cell of outer padding and a `userMessageBg` background to the editor's border and content lines.

The surface renderer treats ANSI cursor sequences as control data. It paints visible text runs independently so a reset that closes the reverse-video cursor cell cannot clear the rest of the line's background. It does not paint autocomplete rows. At widths that cannot preserve the editor's existing narrow-width guarantees, the component falls back to the current unpadded rendering.

`InteractiveMode` enables the surface only for the built-in `defaultEditor`. The existing selector and extension-editor swap paths continue to mount their component directly.

## Acceptance criteria

- [x] Tests prove that the default prompt block has a full-width `userMessageBg` surface with one blank surface row above and below it.
- [x] Tests prove a focused empty editor retains its hardware cursor marker and one closed reverse-video cursor cell while background coverage resumes after it.
- [x] The surface renderer stops at the second editor border, leaving autocomplete rows outside the composer background.
- [x] Width tests cover 120 through 1 columns and never permit an overflow.
- [x] Existing prompt prefix, placeholder, command-color, and multiline tests continue to pass.
- [x] A rendered interactive session shows the filled prompt surface above the existing one-line status tray.
- [x] `npm run check`, the narrow custom-editor suite, the coding-agent suite, and root `npm test` pass.
- [x] `git diff -- packages/tui` is empty.

## Verification

Implemented in verified commit `2bd3008f1` (`git cat-file -t` returned `commit`).

- `npm run check` passed, including the documentation lifecycle, TypeScript, and frozen-package checks.
- `npm run build` passed.
- `npm --workspace packages/coding-agent test -- custom-editor-chrome.test.ts` passed: 1 file, 34 tests.
- `npm --workspace packages/coding-agent test` passed: 318 files, 2,746 tests; 6 files and 57 tests skipped.
- `npm test` passed: root scripts, scrubber, agent-core (20 files / 398 tests), and coding-agent (317 files / 2,731 tests; 6 files and 57 tests skipped).
- The Impeccable detector reported no findings for the two changed UI files.
- A fresh local interactive session rendered the filled, padded dock above the one-line status tray. The run selected session-only project trust and wrote no project trust state.
- `git diff -- packages/tui` produced no output.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| The claim that a filled composer is unsupported through Apex-owned code | design conclusion | Replaced by the `CustomEditor` surface renderer. |
| Text-only `bash` and `busy` labels as the only composer polish | behavior | Retained as state feedback, but no longer the whole composer refinement. |

## Risks

- The editor emits ANSI sequences for the hardware cursor and reverse-video cursor cell. A wrapper that treats those sequences as normal text can break cursor placement or clear the background after the cursor.
- Reducing the width before the inherited editor renders can expose off-by-one wrapping bugs. The narrow-width matrix remains the boundary test.
- A generic wrapper can paint autocomplete or extension content. The implementation paints only the default editor's block.
