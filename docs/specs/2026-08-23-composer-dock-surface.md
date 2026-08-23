# Spec: Composer dock surface

## Metadata

| Field | Value |
| --- | --- |
| Author | `Apex Code` |
| Status | `Active` |
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

- [ ] Render the default prompt editor as a quiet, filled surface using the existing `userMessageBg` token.
- [ ] Add one cell of horizontal and vertical breathing room around the editor block when width permits.
- [ ] Keep the prompt prefix, placeholder, command tint, cursor marker, reverse-video cursor cell, wrapping, and narrow-width fallback intact.
- [ ] Keep autocomplete outside the filled editor surface.
- [ ] Leave selectors, extension input, and extension editor replacement behavior unchanged.
- [ ] Keep `packages/tui` unchanged.

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

- Tests first prove that the default prompt block has a full-width `userMessageBg` surface with one blank surface row above and below it.
- Tests prove a focused empty editor retains its hardware cursor marker and one closed reverse-video cursor cell while background coverage resumes after it.
- Tests prove autocomplete rows do not receive the composer background.
- Width tests cover 120 through 1 columns and never permit an overflow.
- Existing prompt prefix, placeholder, command-color, and multiline tests continue to pass.
- A rendered interactive session shows the filled prompt surface above the existing one-line status tray.
- `npm run check`, the narrow custom-editor suite, the coding-agent suite, and root `npm test` pass.
- `git diff -- packages/tui` is empty.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| The claim that a filled composer is unsupported through Apex-owned code | design conclusion | Replaced by the `CustomEditor` surface renderer. |
| Text-only `bash` and `busy` labels as the only composer polish | behavior | Retained as state feedback, but no longer the whole composer refinement. |

## Risks

- The editor emits ANSI sequences for the hardware cursor and reverse-video cursor cell. A wrapper that treats those sequences as normal text can break cursor placement or clear the background after the cursor.
- Reducing the width before the inherited editor renders can expose off-by-one wrapping bugs. The narrow-width matrix remains the boundary test.
- A generic wrapper can paint autocomplete or extension content. The implementation paints only the default editor's block.
