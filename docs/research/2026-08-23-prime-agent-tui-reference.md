# Research: Prime Agent terminal UI reference

**Date:** 2026-08-23  
**Status:** Permanent research note  
**Upstream:** `PrimeIntellect-ai/prime-agent` at commit [`e319a66d7351c75abe7f040d02d9a8d6e25028e9`](https://github.com/PrimeIntellect-ai/prime-agent/tree/e319a66d7351c75abe7f040d02d9a8d6e25028e9)  
**Scope:** The terminal color system, interactive layout, composer, status tray, startup resources, tool rendering, responsive behavior, accessibility, customization, tests, and license.

This note uses only Prime Agent's public GitHub repository, first-party documentation, and license. The **Observed upstream behavior** section records facts. The **Recommendations for Apex Code** section is design guidance, not a claim about Prime Agent.

## Observed upstream behavior

### Source map

Prime Agent is a Pi-lineage monorepo. Its public README says that the agent and TUI are built on `pi`, and the package README describes Prime Agent as an independent hard fork that retains inherited `@earendil-works/pi-*` identifiers for compatibility. [Root README lines 115-119](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/README.md#L115-L119), [coding-agent README lines 10-16](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/README.md#L10-L16)

The visual system is concentrated in these paths:

| Concern | Upstream source |
| --- | --- |
| Interactive hierarchy and fullscreen dock | [`interactive-mode.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts) |
| Prime palette | [`prime.json`](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/prime.json) |
| Theme loading and terminal adaptation | [`theme.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts) |
| Composer behavior | [`custom-editor.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/custom-editor.ts) |
| One-line status tray and optional agents tile | [`subagent-summary-line.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/subagent-summary-line.ts) |
| Empty default footer | [`footer.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/footer.ts) |
| Generic tool grouping | [`tool-panel.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/tool-panel.ts), [`tool-execution.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/tool-execution.ts) |
| Theme customization docs | [`docs/themes.md`](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/docs/themes.md) |

### The Prime palette is near-black, neutral, and purple-accented

The `prime` theme defines 24 variables, 55 required color assignments, and three HTML-export colors. Its base values are exact RGB hex values. [Prime theme lines 1-91](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/prime.json#L1-L91)

| Role | Value | Used for |
| --- | --- | --- |
| `bg` | `#050506` | HTML page background |
| `surface` | `#0d0d10` | Tool-panel background and HTML cards |
| `panel` | `#151518` | Custom-message background and HTML info blocks |
| `fg` | `#f4f4f5` | Default foreground reference and thinking-off border |
| `muted` | `#a1a1aa` | Secondary text, tool output, quotes, list bullets |
| `dim` | `#71717a` | Tertiary text and URLs |
| `grid` | `#52525b` | Muted borders, code fences, quotes, and rules |
| `primary` | `#7c6faf` | Accent, normal border, accent border, and high thinking |
| `primarySoft` | `#8d7fc0` | Markdown headings and medium thinking |
| `success` | `#7da876` | Success states and bash mode |
| `warning` | `#f59e0b` | Warnings, custom-message labels, numbers, and types |
| `error` | `#d06f82` | Errors |
| `info` | `#38bdf8` | Links, syntax keywords and functions, low thinking |
| `infoDim` | `#1f6f99` | Defined but unused by the current `colors` map |
| `neutral` | `#d4d4d8` | Inline code, variables, operators, and punctuation |
| `stringMint` | `#8ba888` | Code blocks and syntax strings |
| `selectedBg` | `#222226` | Selected rows |
| `userMsgBg` | `#1a1a1f` | Composer and user-message surface |
| `customMsgBg` | `#151518` | Extension/custom messages |
| `toolPendingBg` | `#101015` | Pending tool background token |
| `toolSuccessBg` | `#0e1510` | Successful tool background token |
| `toolErrorBg` | `#1a0d12` | Failed tool background token |
| `toolDiffAddedBg` | `#015f00` | Added diff blocks |
| `toolDiffRemovedBg` | `#5e0000` | Removed diff blocks |

The active generic tool shell uses `toolPanelBg`, which resolves to `surface`. The pending, success, and error background tokens remain part of the public theme contract and are available to other renderers. [Prime theme lines 48-55](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/prime.json#L48-L55)

The theme contract is broad rather than component-specific. It covers core state colors, content surfaces, Markdown, diffs, syntax, thinking levels, and bash mode. The JSON schema describes each token's intended use. [Theme schema lines 37-92](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme-schema.json#L37-L92), [theme schema lines 95-193](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme-schema.json#L95-L193)

### Theme rendering adapts to the terminal

Prime Agent selects truecolor for modern terminals and quantizes to the xterm 256-color palette for `TERM=dumb`, Linux console, Apple Terminal, and GNU Screen outside tmux. [Theme color-mode detection lines 203-228](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts#L203-L228)

It probes the terminal background and adjusts surfaces when the configured surface is too close to the terminal background. The implementation uses a minimum luminance delta of 12 and an 8% black-or-white blend for passive surfaces. Selection rows use a minimum luminance delta of 28, quantize before evaluation in 256-color mode, and search progressively stronger blends up to 50%. [Theme constants lines 188-197](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts#L188-L197), [selection adaptation lines 427-499](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts#L427-L499), [surface adaptation lines 501-520](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts#L501-L520)

The automatic theme is `prime` on a dark terminal and `light` on a light terminal. It changes when the probed terminal colors change. [Default-theme selection lines 810-817](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts#L810-L817), [terminal-color callback lines 847-863](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts#L847-L863)

### The layout separates the transcript, prompt context, and pinned dock

The interactive mode builds the following component order. [Construction lines 1094-1138](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1094-L1138), [assembly lines 1422-1437](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1422-L1437)

```text
header
main view
  transcript
  shortcut guide
  pending messages
  active status or loader
widgets above prompt
recent-work recap
feature hint
queued messages
side question
composer
one-line session tray
optional agents tile
widgets below prompt
footer slot, empty by default
```

Fullscreen makes the distinction explicit. The header, transcript, widgets, recap, hints, queues, and side questions scroll. The composer, session tray, optional agents tile, and footer form the pinned dock. [Dock grouping lines 7224-7230](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L7224-L7230), [fullscreen assignment lines 7232-7249](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L7232-L7249)

This hierarchy prevents transient hints and queued-message notices from permanently consuming dock height. A regression test asserts that feature hints remain in the scroll area, not the dock. [Hint-placement test lines 63-88](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/test/suite/regressions/4741-hint-placement.test.ts#L63-L88), [hint-placement test lines 90-134](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/test/suite/regressions/4741-hint-placement.test.ts#L90-L134)

### The composer is the main visual anchor

`getEditorTheme()` gives the editor a muted border, the adaptive `userMessageBg` surface, a `toolPanelBg` autocomplete surface, accent-colored selections, and accent-colored slash commands. [Editor-theme mapping lines 1335-1354](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts#L1335-L1354)

The editor defaults to the `> ` prompt. A leading `!` changes the prompt to bash mode, and `!!` selects bash execution that is excluded from context. Recognized slash-command names use the accent color. [Custom editor lines 41-58](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/custom-editor.ts#L41-L58), [custom editor lines 67-115](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/custom-editor.ts#L67-L115)

The composer shows a random concise placeholder on a fresh chat. The same hint appears beside the startup logo until the session has messages. [Editor construction lines 1107-1115](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1107-L1115), [splash hint lines 473-483](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L473-L483)

When a background color exists, the editor enforces at least two columns of horizontal padding, even when `editorPaddingX` is configured as `0`. At very narrow widths, it reduces padding to preserve one content cell. Header and placeholder rows restore the background across ANSI resets and always pad to the allocated width. [Effective-padding rules lines 262-268](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/custom-editor.ts#L262-L268), [header rendering lines 270-285](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/custom-editor.ts#L270-L285), [placeholder rendering lines 287-308](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/custom-editor.ts#L287-L308)

### The footer is empty; the tray carries operational state

Prime Agent's default footer returns no rows. Its source says that model, working directory, cost, tokens, and context percentage are intentionally hidden and available through `/usage`. [Footer lines 4-11](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/footer.ts#L4-L11), [footer render lines 37-40](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/footer.ts#L37-L40)

The row immediately below the editor is `SubagentSummaryLine`, despite that narrow class name. Its normal row left-aligns the agents-view shortcut, depth, model, thinking level, fast tier, and fresh-chat shortcut hint. It right-aligns goal state, heartbeat count, token count, and context percentage. [Tray location lines 6034-6088](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L6034-L6088), [tray context lines 6090-6129](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L6090-L6129)

The tray temporarily replaces the left label with actionable text such as "Press Ctrl+C again to exit" or "Alt+Enter to queue message." [Tray override lines 6022-6032](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L6022-L6032)

If direct subagents exist, the same component adds a three-row bordered tile with running, idle, and inactive counts. It uses text labels and distinct symbols as well as color. It truncates both sides of the info row independently and never renders a line wider than its allocation. [Summary rendering lines 83-122](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/subagent-summary-line.ts#L83-L122), [info-row width logic lines 125-139](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/subagent-summary-line.ts#L125-L139)

### Startup favors a compact brand block, with resources behind verbose mode

The default startup header places a 10-row butterfly mark on the left and `version`, `model`, `cwd`, and a start hint on the right. It hides the metadata column when the remaining width cannot fit a nine-character label plus eight value characters. It middle-truncates the working directory. [Brand header lines 440-485](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L440-L485), [brand header lines 486-511](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L486-L511)

`quietStartup` removes the splash and its surrounding spacer. `--verbose` adds the keybinding guide and loaded-resource listings. [Startup assembly lines 1370-1420](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1370-L1420)

Context files, skills, prompts, extensions, and custom themes render as expandable sections. The collapsed view is an alphabetized comma-separated list in dim text. The expanded view groups resources by scope and shows paths. Diagnostics remain visible on quiet startup when requested. [Resource-section helpers lines 2181-2234](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2181-L2234), [context and skills lines 2264-2287](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2264-L2287), [diagnostics lines 2342-2408](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2342-L2408)

### Tool calls use flat, filled panels with explicit states

The generic tool shell is a full-width filled panel with two columns of horizontal padding. Its first row is a compact `label · status` header. A blank filled row separates the header from call and result content. Child components render at `width - 4`; overflow is truncated before the panel applies its background. [Tool panel lines 4-28](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/tool-panel.ts#L4-L28), [tool panel render lines 62-91](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/tool-panel.ts#L62-L91)

The status vocabulary is textual and stable: `queued`, animated `◇/◈/◆ running`, `done`, or `error`. Success, error, bash-mode, muted, and dim tokens color these words. [Tool header and state lines 484-500](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/tool-execution.ts#L484-L500), [working frames lines 1-8](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/working-icon.ts#L1-L8)

Tool definitions can select the generic panel or render their own framing. IPython and edit use specialized layouts. Bash and edit renderers keep compact call summaries, collapsible output or diffs, elapsed time, and explicit failure text. The generic fallback shows formatted JSON arguments and text output. [Renderer shell selection lines 157-175](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/tool-execution.ts#L157-L175), [panel composition lines 344-390](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/tool-execution.ts#L344-L390), [renderer mounting lines 422-481](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/tool-execution.ts#L422-L481)

Assistant text stays on the terminal background with one column of horizontal padding. User messages use a filled `userMessageBg` box with two columns of horizontal padding and one blank row above and below. [Assistant layout lines 265-283](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/assistant-message.ts#L265-L283), [user-message box lines 56-73](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/user-message.ts#L56-L73)

### Responsive behavior is local to each component

Prime Agent does not use global terminal-width breakpoints. Each component protects its own content:

- The startup header removes metadata when the side-by-side layout no longer fits. [Brand header lines 461-484](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L461-L484)
- The composer reduces its two-column surface padding until one content column remains. [Custom editor lines 262-268](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/custom-editor.ts#L262-L268)
- The status tray budgets the right side first, gives the rest to the left, and truncates both with ellipses. [Subagent summary lines 125-139](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/subagent-summary-line.ts#L125-L139)
- Feature hints use one column of side padding when possible, truncate to one row, and reserve a blank row below. [Feature hint lines 34-45](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/feature-hint.ts#L34-L45)
- Collapsed thinking is forced into one line rather than wrapped. [Collapsed thinking lines 50-65](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/assistant-message.ts#L50-L65)
- Multiline errors wrap within their allocated width, while collapsed errors show one summary plus the expand hint. [Collapsible error lines 93-124](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/collapsible-error.ts#L93-L124)

### Accessibility is partly structural and partly incomplete

Prime Agent does not depend on color alone for tool or agent state. The UI combines color with status words and distinct glyphs. Key hints also spell out the action. [Tool states lines 489-500](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/tool-execution.ts#L489-L500), [agent counts lines 95-105](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/subagent-summary-line.ts#L95-L105), [key-hint formatting lines 61-75](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts#L61-L75)

The code supports an optional hardware cursor for IME use. The setting can be changed through `/settings`. [Settings manager lines 1252-1259](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/core/settings-manager.ts#L1252-L1259), [settings selector lines 374-392](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L374-L392)

The public tree contains no colorblind mode, `NO_COLOR` TUI mode, or ASCII-only symbol preset. The logo source calls itself ASCII but uses Unicode block characters. Tool and agent statuses also use `◇`, `◈`, `◆`, `●`, `◐`, `○`, and box-drawing characters. [Prime logo lines 1-18](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/themes/prime-logo.ts#L1-L18), [working icon lines 1-8](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/working-icon.ts#L1-L8)

The theme adaptation tests protect luminance separation and 256-color quantization. They do not establish a formal WCAG target. The Prime `dim` color, `#71717a`, has a derived WCAG contrast ratio of about `4.22:1` on `#050506`, just below the `4.5:1` normal-text threshold. This calculation is an audit result, not an upstream claim.

### Themes are configurable, but the first-party docs lag the source

Theme discovery supports built-ins, global and project directories, packages, settings paths, and repeatable `--theme` arguments. Active custom theme files hot-reload. [Themes documentation lines 17-28](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/docs/themes.md#L17-L28), [themes documentation lines 118-120](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/docs/themes.md#L118-L120), [theme watcher lines 951-1027](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts#L951-L1027)

Values may be six-digit hex, xterm 256-color indices, variable references, or the terminal default. [Themes documentation lines 254-273](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/docs/themes.md#L254-L273)

The docs are stale at the reviewed commit:

- `docs/themes.md` lists only `dark` and `light`, while the loader registers `prime`, `dark`, and `light`. [Themes documentation lines 17-25](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/docs/themes.md#L17-L25), [theme loader lines 600-615](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts#L600-L615)
- The docs say that themes require 51 tokens, while `prime.json` and the current TypeBox schema define 55 color keys. [Themes documentation lines 141-149](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/docs/themes.md#L141-L149), [runtime schema lines 34-100](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts#L34-L100)
- `docs/settings.md` says that the default theme is `dark`; runtime selects `prime` on dark terminals. [Settings documentation lines 37-47](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/docs/settings.md#L37-L47), [default theme lines 810-817](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/src/modes/interactive/theme/theme.ts#L810-L817)

### Test coverage is component-heavy and width-aware

The reviewed tree has direct tests for the design's risky seams:

| Area | Coverage |
| --- | --- |
| Composer | Placeholder caret, hardware cursor, autocomplete interaction, exact width, background survival across ANSI resets, and header truncation. [`custom-editor.test.ts` lines 174-289](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/test/custom-editor.test.ts#L174-L289) |
| Adaptive color | Surface contrast, selection contrast, 256-color quantization, terminal-defined ANSI colors, and automatic light versus Prime selection. [`theme-adaptive.test.ts` lines 52-321](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/test/theme-adaptive.test.ts#L52-L321) |
| Startup | Blank-row rhythm, metadata selection, randomized prompt hints, and tray ordering. [`interactive-mode-startup.test.ts` lines 37-84](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/test/interactive-mode-startup.test.ts#L37-L84) |
| Status tray | Agent-state projection, keyboard behavior, background survival, and width safety down to one column. [`subagent-summary-line.test.ts` lines 27-99](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/test/subagent-summary-line.test.ts#L27-L99) |
| Prompt dock | Ordering and fullscreen placement. [`4741-hint-placement.test.ts` lines 63-134](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/test/suite/regressions/4741-hint-placement.test.ts#L63-L134) |
| Resource listings | Compact and expanded Context and Skills sections, path grouping, quiet startup, and diagnostics. [`interactive-mode-status.test.ts` lines 4684-5350](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/test/interactive-mode-status.test.ts#L4684-L5350) |
| Tool rendering | Custom renderers, images, fullscreen behavior, edit and bash states, and expand hints. [`tool-execution-component.test.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/test/tool-execution-component.test.ts), [`4583-latest-tool-expand-hint.test.ts`](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/test/suite/regressions/4583-latest-tool-expand-hint.test.ts) |

The default-footer width tests are now weak. The footer returns an empty array, so iterating over its rendered rows proves no visible behavior. [Footer width test lines 21-44](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/test/footer-width.test.ts#L21-L44)

### The MIT license permits adaptation with notice retention

Prime Agent uses the MIT License and names Mario Zechner and Prime Intellect as copyright holders. The license permits use, copying, modification, merging, publication, distribution, sublicensing, and sale. Copies or substantial portions must retain the copyright and permission notice. [License lines 1-21](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/LICENSE#L1-L21)

The package manifest also declares MIT and links the Prime Agent repository. [Package manifest lines 102-108](https://github.com/PrimeIntellect-ai/prime-agent/blob/e319a66d7351c75abe7f040d02d9a8d6e25028e9/packages/coding-agent/package.json#L102-L108)

For Apex Code, the license allows either behavioral reimplementation or direct copying with the required notice. Repository policy still favors behavioral adaptation in Apex-owned `coding-agent` files because Apex consumes `pi-tui` as an upstream dependency and should not patch that package. If implementation copies a substantial Prime Agent file or distinctive code block, retain Prime Agent's MIT notice and record the provenance in the changed file or a third-party notices file.

## Recommendations for Apex Code

### Match the layout before adding more color

Adopt Prime Agent's current information architecture as the target:

1. Keep the transcript visually quiet. Assistant text stays on the terminal background.
2. Use the filled composer as the strongest persistent object.
3. Put recap, hints, queued messages, and side questions immediately above the composer, but keep them in the scroll region in fullscreen mode.
4. Put one responsive information row immediately below the composer.
5. Show a bordered agent tile only when direct subagents exist.
6. Keep the default footer empty. Detailed telemetry belongs in `/usage`.
7. Render tools as flat filled panels with a `label · state` header, one blank separator row, and compact result content.

This sequence matters. Adding more footer fields or more persistent borders would move Apex away from the Prime layout the user prefers.

### Use Prime's neutrals with a gold accent family

Keep Prime's neutral and semantic base. Replace the purple accent family with gold, and move warnings from amber to orange so warnings do not look selected or branded.

| Apex role | Recommended value | Reason |
| --- | --- | --- |
| `bg` | `#050506` | Prime's near-black base |
| `surface` | `#0d0d10` | Tool panels |
| `panel` | `#151518` | Secondary filled blocks |
| `fg` | `#f4f4f5` | Primary text |
| `muted` | `#a1a1aa` | Secondary text |
| `dim` | `#7b7b85` | Slightly lighter than Prime's `#71717a` for small tray text |
| `grid` | `#52525b` | Muted borders |
| `gold` | `#d6b85a` | Accent, normal border, selected text, slash commands |
| `goldSoft` | `#e4cb7a` | Markdown headings and medium thinking |
| `goldDeep` | `#a8842a` | Optional subdued accent, not body text |
| `success` | `#7da876` | Preserve Prime's calm green |
| `warning` | `#e57c24` | Orange separates warnings from gold selection |
| `error` | `#d06f82` | Preserve Prime's rose error |
| `info` | `#38bdf8` | Preserve links and informational syntax |
| `neutral` | `#d4d4d8` | Inline code and neutral syntax |
| `stringMint` | `#8ba888` | Code blocks and strings |
| `selectedBg` | `#222226` | Preserve neutral selection background |
| `userMsgBg` | `#1a1a1f` | Composer and user messages |
| `toolPendingBg` | `#101015` | Pending tool surface |
| `toolSuccessBg` | `#0e1510` | Successful tool surface |
| `toolErrorBg` | `#1a0d12` | Failed tool surface |

Derived WCAG contrast checks for the proposed colors are `10.54:1` for `#d6b85a` on `#050506`, `10.04:1` on `#0d0d10`, `8.97:1` on `#1a1a1f`, and `7.02:1` for warning orange `#e57c24` on `#050506`.

Map gold narrowly:

- `accent`, `border`, and `borderAccent` use `gold`.
- `mdHeading` and `thinkingMedium` use `goldSoft`.
- `thinkingHigh` and `thinkingXhigh` use `gold`.
- Keep `success`, `warning`, `error`, and `info` semantically distinct.
- Do not tint every border gold. Muted editor chrome and passive dividers stay `grid`; focus, commands, selected items, and branded headings earn gold.

### Preserve local width rules

Avoid one global "compact mode." Give each Apex component an explicit narrow-width contract:

- Composer padding falls from two columns to one and then zero.
- The status row preserves the right-side context budget and truncates the left model/location label first.
- Startup metadata disappears before the logo or heading is damaged.
- Tool panels reduce their inner width by four and truncate renderer overflow.
- Hints and thinking recaps stay one line.
- Agent counts keep words as well as symbols, then collapse to a short textual summary at very narrow widths.

### Add the accessibility controls that Prime lacks

Prime Agent is a strong visual reference, not a complete accessibility target. Apex should add:

- An ASCII symbol preset for the logo, spinner, status marks, and boxes.
- A colorblind mode that changes both glyphs and colors.
- A no-color mode that preserves all status words and layout.
- Tests for the gold accent in truecolor, 256-color, light-terminal fallback, and common color-vision simulations.
- A minimum `4.5:1` target for persistent small text such as the tray. Decorative borders and disabled text can use a lower target when their meaning is duplicated.

### Verification targets for the implementation spec

Treat these renders as acceptance artifacts:

1. Fresh startup at 120, 80, 48, and 24 columns.
2. Empty, multiline, slash-command, bash, and autocomplete composer states.
3. Idle, streaming, queued-message, retry, compaction, and double-Ctrl+C tray states.
4. Queued, running, successful, and failed tool panels.
5. No subagents, active subagents, and narrow subagent-tile states.
6. Verbose Context and Skills sections with long names and diagnostics.
7. Truecolor, 256-color, ASCII, no-color, and hardware-cursor configurations.

Use component-level exact-width assertions for escape-sequence correctness, then capture a live terminal render for the integrated hierarchy. The live render is necessary because correct component snapshots can still assemble into the wrong dock order.
