# ADR 0019 — Welcome screen brand mark and startup header

**Status:** Accepted · **Date:** 2026-08-18

## Decision

The interactive startup header leads with a brand mark — a half-block peak — and a
compact runtime metadata column, replacing the text-only header and its inline
keybinding cheatsheet. The cheatsheet moves behind `--verbose`.

## Goal

Replace the text-only startup header with a brand mark and a compact runtime
metadata column. The current screen leads with a wall of keybindings; the new
one leads with a logo and shows only what a user cannot derive from the prompt
itself — version, model, working directory.

Influence: [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent),
which forks the same upstream (Pi) independently of Apex Code. Its
`BrandSplashHeader` layout is sound and its maths port directly.

## What is wrong with the current screen

`interactive-mode.ts:909-968` builds an `ExpandableText` containing:

- `apex-code v0.0.1-alpha.4` as plain accent text — no mark
- a compact keybinding list (interrupt / clear / commands / bash / more)
- a line explaining how to expand into the full keybinding list
- a sentence about Apex Code being able to explain itself

Four of those five elements are instructions. None of them tell the user which
model is loaded or which directory the session is rooted in — the two facts that
actually differ between one launch and the next.

## Design

### The mark

New `src/themes/apex-logo.ts` holding three pre-rendered constants.

Primary, 10 rows x 34 columns, half-block:

```
                ▄▄
              ▄████▄
            ▄████████▄
          ▄████▀  ▀████▄
        ▄████▀      ▀████▄
      ▄████▀          ▀████▄
    ▄████▀              ▀████▄
  ▄████▀                  ▀████▄
▄████▀                      ▀████▄
▀▀▀                            ▀▀▀
```

A peak — the literal meaning of "apex". The hollow interior keeps it from
reading as a solid blob and gives it a second implied summit.

Rendered in `theme.fg("text")`, one flat tone. A single tone is what makes it
read as a mark rather than decoration, and it needs no special case under
`colorBlindMode` (which only adjusts the footer palette anyway).

Two fallbacks:

- **Compact** (6 rows x 18 cols) for terminals under 40 columns, so a narrow
  window degrades to a smaller mark instead of a truncated one.
- **ASCII** (9 rows x 19 cols) for `terminal.symbolPreset: "ascii"`.

### Why ASCII matters here

`symbolPreset` is an Apex-specific accessibility setting
(`settings-manager.ts:1132`) that prime-agent does not have — prime has zero
occurrences of it. Today it is consumed in exactly one place, `footer.ts:105-110`,
where it swaps three glyphs (`↑`→`^`, `↓`→`v`, `•`→`-`).

Nothing obliges a new component to honour it. We are choosing to extend the
convention because anyone who set `ascii` did so because block glyphs render
badly in their terminal, and a ten-row block mark is precisely what they would
hit next.

### The header component

New `components/splash-header.ts` exporting `ApexSplashHeader implements Component`.

Layout constants: `paddingX = 1`, `gutter = 4`, `labelWidth = 9`.

```
metaWidth   = contentWidth - logoWidth - gutter
showMeta    = metaWidth >= labelWidth + 8
metaStart   = floor((logoRows - metaRows) / 2)
```

The metadata column renders only when it has room, and is vertically centred
against the mark so the two read as one composition. Measured degradation tiers:

| Terminal width | Result |
| --- | --- |
| >= 57 | full mark + metadata column |
| 36-56 | full mark alone |
| < 36 | compact mark alone |

The compact mark never carries a metadata column: it is only selected below 36
columns, and the column needs 41 even beside the compact mark.

No line ever exceeds the requested width, and no glyph is ever cut mid-cell.

Metadata rows: `version`, `model`, `cwd`, plus any extras. Labels `dim`, values
`muted`.

`cwd` truncates from the *head*, not the tail — `truncateToWidth` would clip the
leaf directory, which is the part that identifies the session. `truncatePathTail`
keeps whole trailing segments and prefixes `…/`.

All values are getters, not constructor snapshots. `model` is empty at
construction and fills in once `rebindCurrentSession()` completes; reading
`() => this.session.state.model?.id` means the header is correct after that with
no explicit refresh.

Sources:

- version — `this.version`
- model — `this.session.state.model?.id`
- cwd — `formatCwdForFooter(sessionManager.getCwd(), HOME)`, reusing the footer helper
- symbol preset — `this.settingsManager.getSymbolPreset()`

### The hint line

Prime's hint is `type to search sessions`, driven by an `isNewChat()` helper
Apex does not have. Copying it would put a false instruction on the welcome
screen. Apex's existing onboarding sentence is the true equivalent and is what
we keep:

> Apex Code can explain its own features and look up its docs.

It renders *below* the whole block at full content width, not as a row inside the
metadata column. Prime puts its hint in the column, but Prime's hint is 23
characters and ours is 60: confined to the column it truncated even at 96
columns, because the column is only `width - 34 - 4` wide. It is also product
copy rather than a runtime fact, so the label/value column is the wrong home for
it on grounds of meaning as well as fit. Covered by a regression test.

### Constructor style

Apex sets `erasableSyntaxOnly`, so TypeScript parameter properties are a compile
error (TS1294). Prime's `BrandSplashHeader` uses them freely; `ApexSplashHeader`
declares its fields explicitly and assigns them in the constructor body.

## Integration

Replace the `ExpandableText` at `interactive-mode.ts:952` with `ApexSplashHeader`.

**Removed from the default path:** `compactInstructions`, `compactOnboarding`,
and the `ExpandableText` wrapper.

**Moved:** `expandedInstructions` now renders only under `this.options.verbose`,
beneath the mark.

**Deliberately unchanged:** `getStartupExpansionState()` stays — it is still used
by `addLoadedSection` at line 1612. `ctrl+o` keeps expanding tool output and
loaded-resource sections; it simply stops unfolding the header.

All four `setExpanded` call sites (2260, 2272, 4017, 5712) already sit behind
`isExpandable(...)` guards, so a plain `Component` skips them cleanly. No edits
needed at any of them.

### First-time setup

`components/first-time-setup.ts:23` still carries a leftover upstream π mark
(`SETUP_LOGO_LINES`). Swap it for the compact peak so a new user's first two
screens agree.

Caveat: `shouldRunFirstTimeSetup` (`cli/startup-ui.ts:114`) requires
`APEX_CODE_EXPERIMENTAL=1`, so this dialog is currently reachable only behind
that flag. The swap is real work, not dead code, but it is invisible to normal
users until the flag lifts.

## Testing

New `test/splash-header.test.ts`, 24 cases:

- no rendered line exceeds the requested width, at 13 widths from 120 down to 1
  (a single over-long line corrupts the whole frame, so this is checked either
  side of each tier boundary, not just at representative widths)
- no replacement character appears, i.e. no glyph is cut mid-codepoint
- the three degradation tiers select the marks they should
- the ascii preset selects the ASCII mark and emits no block glyphs
- `model` reflects a getter that resolves *after* construction
- the hint survives in full at 120 / 96 / 70 columns
- a long cwd keeps its leaf directory
- the cheatsheet is absent by default and below the mark under verbose

`visibleWidth` handles ANSI accounting in the width assertions.

`test/first-time-setup.test.ts` contains no logo assertions, so it needs no
update.

## Files

| File | Change |
| --- | --- |
| `src/themes/apex-logo.ts` | new — three mark constants |
| `src/modes/interactive/components/splash-header.ts` | new — `ApexSplashHeader` |
| `src/modes/interactive/components/index.ts` | export the component |
| `src/modes/interactive/interactive-mode.ts` | replace header block 909-968 |
| `src/modes/interactive/components/first-time-setup.ts` | swap `SETUP_LOGO_LINES` |
| `test/splash-header.test.ts` | new — width and preset coverage |
