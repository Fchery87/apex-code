# Spec: Prime-inspired gold TUI

## Metadata

| Field | Value |
| --- | --- |
| Author | `Apex Code` |
| Status | `Approved` |
| Created | `2026-08-23` |
| Last updated | `2026-08-23` |
| Roadmap phase | `product-surface follow-up after Phase 12` |
| Tracking issue/PR | `none` |
| Reference | Prime Agent at `e319a66d7351c75abe7f040d02d9a8d6e25028e9` |
| Compatibility posture | The interaction model, permission system, context safeguards, accessibility settings, theme loading, extension APIs, and session format remain compatible. `packages/tui` remains byte-identical. |

## Summary

Apex Code will adopt Prime Agent's restrained terminal information architecture and near-black neutral system while retaining an unmistakable Apex identity through a narrow gold accent family. The transcript remains quiet; persistent chrome concentrates in a borderless filled composer, a single responsive safety tray, and flat filled tool panels.

The permission posture is not routine telemetry. Every non-default permission mode remains visible at every terminal width and has the first claim on the tray's width budget. In particular, `bypassPermissions` must never disappear behind model, token, path, agent, or context data.

## Source and clean-room posture

The implementation is based on the behavioral and visual findings in [`docs/research/2026-08-23-prime-agent-tui-reference.md`](../research/2026-08-23-prime-agent-tui-reference.md). Prime Agent is MIT-licensed, but this slice will reimplement the observed behavior in Apex-owned files rather than copying substantial Prime source. The prohibited `c-code` tree is not an input.

## Goals

- [ ] Replace the Apex theme's teal family with a high-contrast gold family over Prime-like near-black neutrals.
- [ ] Keep semantic success, warning, error, and information hues distinct from the brand accent.
- [ ] Render the default composer as a continuous borderless filled slab with two columns of horizontal breathing room and one blank filled row above and below.
- [ ] Retain cursor correctness, wrapping, placeholder, prompt modes, autocomplete separation, extension replacement, and width safety down to one column.
- [ ] Turn the compact footer into a Prime-like information tray that prioritizes permission posture and context safety while demoting routine telemetry.
- [ ] Render tool calls as flat, full-width filled panels with a textual `label · state` header and compact content.
- [ ] Preserve ASCII and colorblind modes and never encode state through color alone.
- [ ] Keep `packages/tui` unchanged.

## Non-goals

- Making the default footer empty. Prime can do this because it does not carry Apex's permission and context safety contract; Apex cannot.
- Hiding the default permission mode. The tray may omit the word `default`, but every non-default mode is mandatory and width-prioritized.
- Copying Prime Agent's butterfly logo, name, purple accent, source files, or distinctive strings.
- Changing permission evaluation, sandbox enforcement, tool contracts, provider routing, or session persistence.
- Adding new configuration switches for the layout.
- Patching or forking `packages/tui`.

## Visual system

The built-in `apex` theme uses these canonical variables:

| Role | Value | Use |
| --- | --- | --- |
| `bg` | `#050506` | terminal ground |
| `surface` | `#0d0d10` | tool panels and quiet filled regions |
| `panel` | `#151518` | secondary panels |
| `fg` | `#f4f4f5` | primary text |
| `muted` | `#a1a1aa` | secondary text |
| `dim` | `#7b7b85` | low-priority tray text |
| `grid` | `#52525b` | subdued rules |
| `gold` | `#d6b85a` | primary accent |
| `goldSoft` | `#e4cb7a` | headings and high thinking |
| `goldDeep` | `#a8842a` | subdued accent |
| `success` | `#7da876` | success |
| `warning` | `#e57c24` | warning, distinct from gold |
| `error` | `#d06f82` | failure and bypass permission mode |
| `info` | `#38bdf8` | links and information |
| `selectedBg` | `#222226` | selection |
| `userMsgBg` | `#1a1a1f` | user messages and composer |
| `toolPendingBg` | `#0d0d10` | neutral/running tool panel |
| `toolSuccessBg` | `#0e1510` | successful tool panel |
| `toolErrorBg` | `#1a0d12` | failed tool panel |

Gold is reserved for selection, prompt focus, headings, slash commands, and Apex identity. Warning remains orange. Links remain blue. Success and error retain green and rose. This prevents a brand highlight from masquerading as operational state.

## Composer

The default editor owns a three-part surface:

1. one full-width blank `userMessageBg` row;
2. editor content rendered without box borders, inset by two cells on each side when width permits;
3. one full-width blank `userMessageBg` row.

The inset degrades locally from two cells to one and then zero so at least one content cell remains. ANSI resets emitted by the reverse-video cursor cannot punch holes in the surface. The hardware cursor marker remains at the logical insertion point. Autocomplete remains outside the surface. Only the built-in default editor receives this treatment; extension components and replacement editors retain their public behavior.

## Safety tray

The compact tray is one row directly below the composer. It has independently budgeted left and right segments.

- Left begins with the non-default permission mode, when present. `bypassPermissions` uses error color; other non-default modes use warning color. Text is the primary signal.
- Right contains context usage and its textual pressure markers.
- Model, thinking effort, cwd/session, token, cache, provider, experimental, and cost data are opportunistic. They may appear only after the mandatory safety pair fits.
- At widths where only one item fits, a non-default permission mode wins. It may be truncated to the available width but may not be replaced by another datum.
- With default permissions, context safety wins the narrowest width.
- The detailed/full token display remains available for users who explicitly select it.

The tray preserves ASCII separators and the colorblind critical-context mapping.

## Tool panels

The generic tool execution shell becomes a full-width filled panel. The panel chooses the existing pending, success, or error background from tool state. It renders:

- a two-cell horizontal inset where width permits;
- a compact first row containing the tool label and textual state separated by a dim middle dot (or ASCII hyphen);
- one filled blank separator row before content when content exists;
- child content constrained to the inner width;
- no persistent outer border.

The state vocabulary remains explicit in text (`queued`, `running`, `done`, `error`). Existing specialized call/result renderers, expansion controls, diffs, image handling, and elapsed-time behavior remain intact inside the new shell.

## Layout and responsiveness

The persistent lower dock order is composer, safety tray, then optional extension/footer content already owned by the interactive mode. Transient hints, queued messages, and side questions remain above the composer. Each component owns its degradation rather than relying on a global breakpoint. No rendered line may exceed its allocated width.

The existing Apex startup identity stays. Its palette follows the gold system, while compact metadata continues to collapse when width is insufficient.

## Acceptance criteria

- [ ] Theme tests assert the canonical gold-neutral variables and token mappings.
- [ ] Theme loading, adaptive/no-color behavior, 256-color behavior, and custom themes remain green.
- [ ] Composer tests prove the borderless three-row slab, two-cell normal inset, narrow degradation, cursor closure, hardware cursor, and autocomplete separation.
- [ ] Footer tests prove every non-default permission mode remains the first visible datum from 120 columns down to one, including `bypassPermissions`.
- [ ] Footer tests prove context pressure remains textual and width-safe when permission mode is default.
- [ ] Tool tests prove full-width filled rows, textual state, content inset, narrow degradation, and no overflow.
- [ ] Existing splash, interaction, accessibility, and specialized tool-renderer tests remain green.
- [ ] A rendered local session visually matches the approved Prime-inspired hierarchy while keeping the permission state visible.
- [ ] `npm run check`, narrow suites, the coding-agent suite, and root `npm test` pass.
- [ ] `git diff -- packages/tui` is empty.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| Teal Apex accent family in `apex.json` | visual system | Replaced by the approved gold family. |
| Bordered composer rectangle specified by `2026-08-23-composer-dock-surface.md` | layout | Replaced by the borderless filled slab; cursor and background-safety guarantees are retained. |
| One-cell normal composer inset | layout | Replaced by two cells with local narrow-width degradation. |
| Tool execution's persistent outer border | layout | Replaced by a flat filled panel with textual header state. |
| Routine compact telemetry having equal status with permission/context | information hierarchy | Demoted behind the mandatory safety signals. |

## Risks

- The reverse-video cursor emits resets that can clear a background mid-line; the composer painter must resume its fill after every reset.
- A two-cell inset can starve narrow terminals; width matrices must cover one through 120 columns.
- Tool implementations vary widely. The shell must not double-frame specialized content or change tool result semantics.
- Gold and warning are adjacent warm hues. Fixed contrast tests and explicit state words are required.
- Simplifying the tray can accidentally erase a safety state. Permission-priority tests are a release gate, not a visual snapshot preference.
