# Spec: One grammar for the chrome around the transcript

**Status:** Active

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Created | `2026-09-22` |
| Last updated | `2026-09-22` |
| Roadmap phase | `none — product-surface follow-up` |
| Tracking issue/PR | `none` |
| Compatibility posture | `Presentation, plus one default. collapseChangelog now defaults to true; an explicit false keeps the full notes. No session file, CLI flag, or extension API changes shape. Components an extension mounts in the composer dock move two columns right with everything else there.` |

## Summary

The pickers, hint rows, footer, and launch notes each follow their own
conventions. Hint rows use three grammars, pickers sit at three different left
edges, titles mix cases, and a few labels are unexplained abbreviations. This
change gives the dock one left edge, gives every hint row one grammar, and fixes
the labels.

## Context

- `docs/specs/2026-09-22-transcript-polish.md` fixed the transcript. This is the
  second half of the same review.
- `docs/specs/2026-08-23-composer-dock-surface.md` set the composer's layout. The
  composer prompt `›` sits at column 2.
- `packages/tui` is a dependency (ADR 0001). Two defects live there and are out of
  reach: `SelectList` truncates a palette row's label and description without an
  ellipsis, inside a private `Editor` method, and `Input` hard-codes `> `. The
  second is reachable through subclassing, which is public API.

## The problem

Observed in a live session at 120 columns on `v0.4.0`.

- **Hint rows.** The palette and `/model` say `up/down move · enter select ·
  escape/ctrl+c dismiss`. `/settings` says `Type to search · Enter/Space to change
  · Esc to cancel`. A settings submenu says `Esc to go back`. The thinking picker
  hard-codes `Ctrl+S`, so it misreports a rebound key. The login dialog wraps its
  hints in parentheses.
- **Left edge.** The palette's rule and hints start at column 2, `/model` and
  `/settings` at column 0, and the login, trust, OAuth, and extension dialogs at
  column 1.
- **Prompt glyph.** Picker search boxes draw `>`; the composer draws `›`.
- **Titles.** `/settings` has none. Others read "Model Configuration", "Rename
  Session", "Fork from Message", "Project Local Resources", beside "Project trust"
  and "Select a provider".
- **Palette tag.** Every skill row carries `[u]`, a one-letter scope code that is
  explained nowhere.
- **Footer.** `CH95.0%` does not say what it measures. After a failed request the
  gauge lit a cell beside `0.0%`, which contradicts it.
- **Launch.** An update shows about forty lines of release notes written for
  maintainers.

The `/model` effort meter was also reported as misaligned. It is not: squares pad
to a shared width and the label column lines up. A two-level model shows `■□` and
a three-level model `■■□`, which is information. It is out of scope.

## Design

**Hint rows.** `hintRow(hints)` in `keybinding-hints.ts` renders every row as
lower-case `key action` pairs joined by a muted ` · `. A hint names a keybinding
id, so a rebound key is reported correctly, or a literal key for the few that are
not bindings. Every hand-built row moves onto it. The `pi-tui` settings list builds
its own row, but Apex supplies that list's `hint` theme function, so the function
replaces the list's two known hint strings with an Apex row. The typing affordance
is dropped from the words, because the search box's prompt glyph already says it.

**Dock.** `editorContainer` becomes a `ComposerDock`. It renders the composer as
is and insets anything else two columns, the composer prompt's column. Every
picker, dialog, and extension component mounted there inherits one left edge from
one place. Components that padded themselves by one column stop, so they are not
inset twice.

**Prompt glyph.** `SearchInput` extends `Input` and draws `› ` in place of `> `.
Both are two columns wide, so the cursor position is unchanged. Every Apex picker
constructs it.

**Titles.** Sentence case everywhere. `/settings` gains a "Settings" title in the
shared style.

**Palette tag.** The scope code is dropped. A package source is still named
(`npm:…`, `git:…`), since that is information a user can act on.

**Footer.** `cache 95%` replaces `CH95.0%`. Context usage below 0.1% reads `<0.1%`,
so the lit cell and the number agree; zero still reads `0.0%` over an empty gauge.

**Launch.** `collapseChangelog` defaults to true. An update shows one line naming
the version and `/changelog`.

## Acceptance criteria

- [ ] No hint row in `components/` or `interactive-mode.ts` is hand-joined, and none
      uses capitalised keys or "to" phrasing.
- [ ] `/settings` shows `enter/space change · escape/ctrl+c close` or the rebound
      equivalent.
- [ ] Every component mounted in the composer dock starts at column 2.
- [ ] Every Apex picker's search box starts with `›`.
- [ ] Every picker title is sentence case, and `/settings` has one.
- [ ] No palette row carries `[u]`, `[p]`, or `[t]`.
- [ ] The footer reads `cache N%`, and usage between 0 and 0.1% reads `<0.1%`.
- [ ] An update with default settings shows one line of release notes.

## Verification

- Focused suites for each touched component, then `npx tsgo --noEmit` and
  `npm test`.
- Live session in tmux at 120 columns: the palette, `/model`, `/settings`, a
  settings submenu, and the footer after a turn.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| Hand-joined hint rows in each selector | code | Replaced by `hintRow`. |
| `Type to search`, `Type to filter` hint words | copy | Deleted. The prompt glyph carries it. |
| Hard-coded `Ctrl+S` in the thinking picker | copy | Replaced by the bound key. |
| Per-component one-column padding in dock dialogs | code | Deleted. The dock owns the inset. |
| `>` search prompt in Apex pickers | behavior | Replaced by `›`. |
| One-letter scope tags in the palette | copy | Deleted. |
| `CH` footer label | copy | Replaced by `cache`. |
| Full release notes after an update, by default | behavior | Replaced by one line. The full text stays behind `/changelog` and `collapseChangelog: false`. |
