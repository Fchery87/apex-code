# ADR 0022 — Ember palette, a mark that does not shrink, and a counted startup

**Status:** Accepted · **Date:** 2026-08-25 · **Supersedes:** parts of [ADR 0019](0019-welcome-screen-brand-mark.md)

## Decision

The `apex` theme moves from a gold primary to a muted ember accent on a
near-black ground. The block wordmark stops having a smaller variant. The
startup screen replaces its resource inventory with a counted line, and gains
`/resources` to hold the detail. The status tray gains a context gauge, and tool
panels gain a lifecycle spine.

## What ADR 0019 got right and what changes

ADR 0019's construction rule survives intact and is the reason this retune was
a small change: `accent`, `border`, and `borderAccent` all resolve to one var,
so the identity is retunable in one line. Semantic var names over hue names
proved out for the same reason — nothing in the palette was named `gold`.

Three of its specifics are superseded.

**The primary is ember, not gold.** `#c87a46` replaces `#d6b85a`. Gold on
near-black reads as decoration; a desaturated orange reads as a brand colour and
leaves the greys room to do the structural work.

**The grey ramp has four steps, not two.** The gold palette gave rules and
labels the same value, which is precisely why its metadata column read flat.
`line`, `dim`, `muted`, and `text` are now four distinct values, and a test
asserts they stay distinct.

**The mark does not shrink.** ADR 0019 specified a compact variant for terminals
under 40 columns. Prototyping the short block forms showed they do not read at
all: every monospace face leaves a hairline gap at the cell boundary, so a
letterform two or three rows tall dissolves into texture rather than spelling a
word. Below the block mark's width it is now replaced outright by a
`◤ apex code` type lockup.

ADR 0019's ASCII mark is also withdrawn. It was line-drawn art whose first
letter was an `O`, so the accessibility fallback spelled **OPEX**. The ASCII
preset now gets the type lockup, which cannot drift that way.

## The startup screen

ADR 0019 correctly diagnosed that four of the old screen's five elements were
instructions, and replaced them with runtime facts. It left the resource
inventory alone. On a developer machine that inventory is 115 skill names across
fifteen rows, followed by a conflict trace carrying absolute paths.

The screen now shows counts in a ruled band: `115 skills · 1 conflict`, with
`/resources` beside it when it fits whole rather than clipped to a stub.

Two rules constrain the collapse:

- **Errors are not summarised.** A warning means two resources disagree; the
  count is enough. An error means a resource did not load, and that still prints
  inline with its path.
- **Nothing is hidden without a route to it.** `/resources` is new in this
  change. The full listing previously existed only behind `--verbose`, with no
  in-session route, so collapsing the wall without adding one would have
  destroyed information rather than relocated it.

## Redundant channels, not replacements

Both new indicators are decoration over a value that is already stated in text,
which is what keeps them inside the tray's existing WCAG 1.4.1 posture.

The context gauge sits beside the percentage, never instead of it, and tracks
the colour the text already uses at each pressure threshold. It cost the tray
nine columns, which pushed the fit ladder into its compact form early and lost
the spelled-out permission mode at widths that previously kept it. The gauge
therefore has its own rung in that ladder and is the first thing dropped.

The tool spine sits in the first column of the panel's existing left padding, so
it costs no content width and no rows. The lifecycle word in the panel header
remains the channel that carries all four states in text.

`running` takes the accent rather than `warning`. Work in progress is not a
caution, and amber stays reserved for states the user may need to act on.

## Consequences

`packages/tui` stays byte-identical, so ADR 0001 holds. `dark` and `light` are
untouched and still selectable. Two tests in `apex-theme.test.ts` that pinned
the gold values by hand move to the ember values, because they encoded the
decision this ADR supersedes.
