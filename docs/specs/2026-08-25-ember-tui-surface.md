# Spec: Ember TUI surface

## Metadata

| Field | Value |
| --- | --- |
| Author | `Apex Code` |
| Status | `Complete` |
| Created | `2026-08-25` |
| Last updated | `2026-08-26` |
| Roadmap phase | `product-surface follow-up after the composer dock` |
| Tracking issue/PR | `none` |
| Compatibility posture | `packages/tui` remains byte-identical. `dark` and `light` are unchanged and still selectable. The header's `logo` option, the editor, autocomplete, and every selector behave as before. |

## Summary

Retune the `apex` theme onto a muted ember accent over a near-black ground,
replace the shrinking brand mark with a mark that degrades to type, collapse the
startup resource inventory into a counted line behind `/resources`, add a
context gauge to the status tray, and mark tool lifecycle with a spine.

## Context

The design was settled by prototype before any code was written. Three
directions for the launch screen and three for the tool-call surface were built
as an interactive terminal simulation at the real character grid, reviewed, and
chosen from. The prototype is throwaway and is not in this repository.

Two findings from it drove the shape of the work:

- The block wordmark cannot be made smaller. Short block letterforms dissolve on
  a monospace grid, so the mark had to degrade to type rather than to a smaller
  block.
- The launch screen's real problem was the resource inventory, not the palette.
  Colour alone would have left a wall of 115 skill names in place.

## Goals

- [x] Ember palette with a four-step grey ramp and no fully saturated hue.
- [x] A brand mark that degrades to a type lockup instead of an unreadable block.
- [x] A startup screen that counts resources instead of listing them.
- [x] An in-session route to the detail that the counted line replaces.
- [x] A context gauge that is redundant with the percentage it sits beside.
- [x] A tool lifecycle spine that costs no content width and no rows.
- [x] One selector shape across commands, file references, and permission.
- [x] Terminal resize reflows the UI.
- [x] `packages/tui` untouched.

## Non-goals

- Changing `dark` or `light`, or adding a light brand palette.
- Changing the composer dock, autocomplete, or selector behaviour.
- Adding a setting for any of the above.
- Fixing `packages/ai`, which fails `tsgo` on clean `HEAD` (see Verification).

## Design

**Palette.** `apex.json` keeps ADR 0019's construction rule, where `accent`,
`border`, and `borderAccent` all resolve to one var. The hue becomes ember
`#c87a46`; `line`, `dim`, `muted`, and `text` become four distinct greys; diff
colours move off the inherited `#3fb950` / `#f85149` onto desaturated sage and
brick.

**Mark.** `apex-logo.ts` becomes a registry of marks rather than loose string
constants. A mark is rows of `{accent, text}`, one shape covering both forms:
the block wordmark puts its whole baseline row in the accent so the letters sit
on an ember footing, and the type lockup puts only its leading glyph there.
Selection is a table lookup over `(symbolPreset, contentWidth)`.

**Startup.** `ApexSplashHeader` gains a ruled inventory band fed by a caller
supplied line, so the header stays a renderer and the resource loader stays on
its own side of the seam. `interactive-mode` builds that line from one grouped
diagnostic table that also feeds the detailed listing, so the count and the
listing cannot disagree. Warnings collapse into the count; errors still print
inline. `/resources` forces the full listing.

**Gauge.** `renderContextGauge` returns filled and empty runs separately so the
footer can colour them independently. It takes its own rung in the tray's fit
ladder, above the compact form, so it is dropped before the spelled-out
permission mode is.

**Spine.** `ToolPanelComponent` draws a one-column spine in the first column of
its existing left padding, coloured by lifecycle and dropped below two columns
of padding.

**Overlays.** Two shared pieces carry the selector shape. `DynamicBorder` is the
boundary every overlay draws, so it becomes a dotted rule in `borderMuted`
rather than a solid one in the accent. `SelectListTheme.selectedText` lights the
selected row with a background step instead of accent-coloured text, which
reaches every list at once. The background painter `tool-panel` already needed
moves into `theme.ts` so both callers share it. Per-surface: `CustomEditor`
brackets the autocomplete rows with a rule and a keybinding footer, found by the
same border count it already uses; the model selector's hints move below the
list.

**Resize.** The interactive UI runs inside the sandbox, which `bwrap
--new-session` leaves without a controlling terminal, so its stdout reports a
window size frozen at sandbox creation. The supervisor publishes the real size
to a file in the bind-mounted workspace and the child watches it and republishes
a `resize`.

## Acceptance criteria

- [x] No theme var exceeds 0.75 saturation, and the four greys stay distinct.
- [x] The block mark is selected at or above its width and the type lockup below.
- [x] The ASCII preset emits no block glyph and spells the product name.
- [x] The metadata column renders in full beside a one-row mark.
- [x] The inventory band drops whole rather than clipping, at every width.
- [x] No header line exceeds the requested width, from 120 columns down to 1.
- [x] The gauge spans exactly eight cells, grows monotonically, lights one cell
      for any non-zero usage, and shows an empty track when the percentage is
      unknown.
- [x] Narrowing past the gauge keeps `bypassPermissions` and the exact figure.
- [x] The tool panel keeps its full width with the spine present.
- [x] `git diff -- packages/tui` is empty.

## Verification

- `npm --workspace packages/coding-agent test` passes.
- Live session at 100, 56, 40, and 28 columns confirmed each degradation tier:
  full mark with metadata, full mark with truncated values, full mark with the
  gauge dropped and `bypassPermissions` intact, and the type lockup with the
  compact tray.
- Tool panels rendered against the real theme in all four lifecycles under both
  symbol presets.
- `git diff -- packages/tui` produced no output.

`npm run check` and a full `npm run build` cannot complete on this branch.
`packages/ai/src/providers/cloudflare-ai-gateway.ts` fails `tsgo` on clean
`HEAD`, from the deliberate revert in `678848367`, with the fix in flight in a
separate worktree. That failure is unrelated to this change and is not addressed
here. In its place, every commit was gated on Biome over
`packages/coding-agent`, `tsgo -p packages/coding-agent/tsconfig.build.json`,
the relevant tests, and a `packages/tui` diff check.

One unrelated blocker was fixed to land anything at all: Biome 2.x walks the
tree for nested configuration roots regardless of `files.includes`, so any live
worktree under `.worktrees` aborted the lint. It is force-ignored from the
scanner the same way `node_modules` already is, in its own commit.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `APEX_PEAK_LOGO`, `APEX_PEAK_LOGO_COMPACT`, `APEX_PEAK_LOGO_ASCII` | constants | Replaced by the mark registry. |
| The compact block mark | behavior | Deleted. Short block forms do not read; the type lockup replaces it. |
| The line-drawn ASCII mark | asset | Deleted. It spelled OPEX. |
| Doc comments stating dimensions none of the three marks had | comments | Deleted. |
| Gold `#d6b85a` as the brand primary | palette | Replaced by ember `#c87a46`. |
| `#3fb950` / `#f85149` diff colours | palette | Replaced by sage and brick. |
| Four copy-pasted diagnostic render blocks | code | Replaced by one grouped table. |
| The startup skill-name listing at default verbosity | behavior | Replaced by a count; the listing moves to `/resources`. |
| `apex-theme.test.ts` assertions pinning the gold vars | tests | Moved to the ember vars. |
| Full-width accent rules around every overlay | behavior | Replaced by a quiet dotted rule. |
| Accent-coloured selected rows | behavior | Replaced by a background step with full-contrast text. |
| `paintBackground` duplicated in `tool-panel` | code | Moved to `theme.ts`; both callers share it. |
| The model selector's hint row above the list | behavior | Moved to a footer below it. |
| The composer placeholder listing the entry points in prose | copy | Replaced by the sigil row; placeholder is now "Ask anything". |

## Risks

- A terminal that reports truecolor but renders block glyphs poorly will show a
  weak mark. The ASCII preset remains the escape hatch and now degrades to type.
- The gauge's fit rung is width-sensitive. The regression that it exists to
  prevent is covered by a test at width 40.
- `/resources` is a new command name and could collide with an extension
  command. The existing built-in conflict diagnostic already reports that case.
