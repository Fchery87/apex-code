> Apex Code can create themes. Ask it to build one for your setup.

Themes control the colors Pi uses in interactive mode and HTML exports. Pi includes `dark` and `light` themes. You can select one theme, follow your terminal's light or dark appearance, or create your own palette.

<a id="selecting-a-theme"></a>

## Choose a theme

Open `/settings` and select **Theme**. You can use one theme for every terminal appearance or choose separate themes for light and dark terminals.

## Locations

Apex Code loads themes from:

- Built-in: `dark`, `light`
- Global: `~/.apex-code/agent/themes/*.json`
- Project: `.apex-code/themes/*.json` (only after the project is trusted)
- Packages: `themes/` directories or `pi.themes` entries in `package.json` (`pi` is Apex Code's retained package-manifest key; see [Environment compatibility](../README.md#environment-compatibility))
- Settings: `themes` array with files or directories
- CLI: `--theme <path>` (repeatable)

Disable discovery with `--no-themes`.

## Selecting a Theme

Select a theme via `/settings` or in `settings.json`:

```json
{
  "theme": "dark"
}
```

On first run, Apex Code detects your terminal background and defaults to `dark` or `light`.

```json
{
  "theme": "light/dark"
}
```

When automatic mode is active, Pi changes themes when the terminal reports an appearance change. Theme names cannot contain `/` because Pi reserves it for this setting format.

Use `--use-theme` to choose the initial theme for one invocation without changing the saved setting:

```bash
apex-code --use-theme light
apex-code --use-theme light/dark
```

See [CLI resources](cli.md#resources) for the command-line option.

## Create a custom theme

Copy one of the [built-in themes](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/modes/interactive/theme) or create a new JSON file conforming to the [schema](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json).

```bash
mkdir -p ~/.apex-code/agent/themes
vim ~/.apex-code/agent/themes/my-theme.json
```

Use the theme name as the filename. Pi hot-reloads the active user theme only from `<agent-dir>/themes/<name>.json`. Run `/reload` after adding or changing a theme from any other source.

```json
{
  "$schema": "https://raw.githubusercontent.com/Fchery87/apex-code/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "borderMuted": "secondary",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "selectedBg": "#2d2d30",
    "scrollbarTrack": "secondary",
    "scrollbarThumb": "",
    "searchMatchBg": "#2d2d30",
    "searchMatchText": "",
    "userMessageBg": "#2d2d30",
    "userMessageText": "",
    "customMessageBg": "#2d2d30",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdLinkUrl": "secondary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "mdQuoteBorder": "secondary",
    "mdHr": "secondary",
    "mdListBullet": "#00ffff",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "toolDiffContext": "secondary",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxVariable": "#ffaa00",
    "syntaxString": "#00ff00",
    "syntaxNumber": "#ff00ff",
    "syntaxType": "#00aaff",
    "syntaxOperator": "primary",
    "syntaxPunctuation": "secondary",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "thinkingMax": "#ff0088",
    "bashMode": "#ffaa00"
  }
}
```

| Property | Required | Responsibility |
|---|---|---|
| `$schema` | No | Enables editor validation and completion against Pi's published schema. |
| `name` | Yes | Identifies the theme in selectors and settings. It must be unique and cannot contain `/`. |
| `vars` | No | Defines reusable color values. Variables can reference other variables. |
| `colors` | Yes | Assigns colors to terminal UI roles. The schema identifies required and optional roles. |
| `export` | No | Overrides page and panel backgrounds in HTML exports. |

**Hot reload:** When you edit the currently active custom theme file, Apex Code reloads it automatically for immediate visual feedback.

| Form | Example | Meaning |
|---|---|---|
| RGB hexadecimal | `"#00aaff"` | A six-digit RGB color. |
| 256-color index | `39` | An ANSI palette index from `0` through `255`. |
| Variable reference | `"primary"` | The value of an entry in `vars`. |
| Terminal default | `""` | The terminal's default foreground or background color. |

```json
{
  "$schema": "https://raw.githubusercontent.com/Fchery87/apex-code/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "gray": 242
  },
  "colors": {
    "accent": "blue",
    "muted": "gray",
    "text": "",
    ...
  }
}
```

Use the [theme JSON schema](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json) for the exact properties, required colors, and accepted value types.

Pi reports invalid theme files during startup and `/reload`.

## Find the color to change

Theme colors describe interface roles rather than individual components. Use these groups to find the relevant part of the schema:

| Area | Color names |
|---|---|
| General interface | `accent`, `border*`, `text`, `muted`, `dim`, `success`, `error`, `warning` |
| Selection and fullscreen | `selectedBg`, `searchMatch*`, `scrollbar*` |
| Messages | `userMessage*`, `customMessage*`, `thinkingText` |
| Tool execution | `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, `toolOutput` |
| Markdown | `md*` |
| Tool diffs | `toolDiff*` |
| Syntax highlighting | `syntax*` |
| Editor modes | `thinking*`, `bashMode` |
| HTML export | `export.pageBg`, `export.cardBg`, `export.infoBg` |

The schema is the format reference. The built-in themes provide complete values that you can copy and adjust.

Five colors are optional and inherit another color when omitted:

| Optional color | Fallback |
|---|---|
| `scrollbarTrack` | `muted` |
| `scrollbarThumb` | `text` |
| `searchMatchBg` | `selectedBg` |
| `searchMatchText` | `text` |
| `thinkingMax` | `thinkingXhigh` |

If `export` colors are omitted, Pi derives HTML page and panel backgrounds from `userMessageBg`.

## Load a theme from a project or package

Place a project theme in `.apex-code/themes/`. Project themes load only after [project trust](security.md#understand-project-trust) is granted.

You can also load theme files and directories through the `themes` setting or distribute them in a Pi package. See [Configuration](configuration.md), [Settings](settings.md#resources), and [Pi Packages](packages.md).

### Syntax Highlighting (9 colors)

| Token | Purpose |
|-------|---------|
| `syntaxComment` | Comments |
| `syntaxKeyword` | Keywords |
| `syntaxFunction` | Function names |
| `syntaxVariable` | Variables |
| `syntaxString` | Strings |
| `syntaxNumber` | Numbers |
| `syntaxType` | Types |
| `syntaxOperator` | Operators |
| `syntaxPunctuation` | Punctuation |

### Thinking Level Borders (6 required, 1 optional)

Editor border colors indicating thinking level (visual hierarchy from subtle to prominent):

| Token | Purpose |
|-------|---------|
| `thinkingOff` | Thinking off |
| `thinkingMinimal` | Minimal thinking |
| `thinkingLow` | Low thinking |
| `thinkingMedium` | Medium thinking |
| `thinkingHigh` | High thinking |
| `thinkingXhigh` | Extra high thinking |
| `thinkingMax` | Maximum thinking; optional, falls back to `thinkingXhigh` |

### Bash Mode (1 color)

| Token | Purpose |
|-------|---------|
| `bashMode` | Editor border in bash mode (`!` prefix) |

### HTML Export (optional)

The `export` section controls colors for `/export` HTML output. If omitted, colors are derived from `userMessageBg`.

```json
{
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24",
    "infoBg": "#3c3728"
  }
}
```

## Color Values

Four formats are supported:

| Format | Example | Description |
|--------|---------|-------------|
| Hex | `"#ff0000"` | 6-digit hex RGB |
| 256-color | `39` | xterm 256-color palette index (0-255) |
| Variable | `"primary"` | Reference to a `vars` entry |
| Default | `""` | Terminal's default color |

### 256-Color Palette

- `0-15`: Basic ANSI colors (terminal-dependent)
- `16-231`: 6×6×6 RGB cube (`16 + 36×R + 6×G + B` where R,G,B are 0-5)
- `232-255`: Grayscale ramp

### Terminal Compatibility

Apex Code uses 24-bit RGB colors. Most modern terminals support this (iTerm2, Kitty, WezTerm, Windows Terminal, VS Code). For older terminals with only 256-color support, Apex Code falls back to the nearest approximation.

Check truecolor support:

```bash
echo $COLORTERM  # Should output "truecolor" or "24bit"
```

## Tips

**Dark terminals:** Use bright, saturated colors with higher contrast.

**Light terminals:** Use darker, muted colors with lower contrast.

**Color harmony:** Start with a base palette (Nord, Gruvbox, Tokyo Night), define it in `vars`, and reference consistently.

**Testing:** Check your theme with different message types, tool states, markdown content, and long wrapped text.

**VS Code:** Set `terminal.integrated.minimumContrastRatio` to `1` for accurate colors.

## Examples

See the built-in themes:
- [dark.json](../src/modes/interactive/theme/dark.json)
- [light.json](../src/modes/interactive/theme/light.json)
