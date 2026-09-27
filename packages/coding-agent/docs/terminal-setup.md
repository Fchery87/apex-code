# Configure your terminal

Apex Code uses the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) for reliable modifier key detection. Most modern terminals support this protocol, but some require configuration.

Pi uses extended-key protocols so terminals can distinguish combinations such as `Shift+Enter` and `Alt+Enter` from plain `Enter`. Terminal proxies, multiplexers, and built-in IDE terminals can change or discard that information.

## Troubleshooting

| Symptom | Start here |
|---|---|
| `Shift+Enter` submits instead of inserting a line | Your terminal's section below; for tmux, see [Run Pi in tmux](tmux.md) |
| `Alt+Enter` does not queue a follow-up | [WezTerm](#wezterm), [Alacritty](#alacritty), or [Windows Terminal](#windows-terminal) |
| Fullscreen scrolling is unusually slow | [iTerm2](#iterm2) |
| Links work but show no hover preview | [Ghostty](#ghostty) |
| Inline images or colors are not detected | [Override detected capabilities](#override-detected-capabilities) |
| An IME candidate window appears in the wrong place | [WezTerm](#wezterm) or [IntelliJ IDEA](#intellij-idea-integrated-terminal) |
| Modified keys fail only inside tmux | [Run Pi in tmux](tmux.md) |

Use `/hotkeys` to inspect Pi's active shortcuts. See [Keybindings](keybindings.md) to change them.

## Kitty

Kitty supports the required keyboard protocol without additional configuration.

## iTerm2

Regular terminal mode works without additional configuration.

### Fix slow fullscreen scrolling

In fullscreen mode, Pi owns the viewport, so iTerm2 sends mouse-wheel reports instead of scrolling native terminal history. Fast trackpad gestures can then move only about one line at a time.

To change this behavior:

1. Open **iTerm2 > Settings > Advanced**.
2. Search for **Trackpad scrolls fast?**.
3. Set it to **No**.

This is an iTerm2-wide setting and can also change native trackpad scrolling. The underlying behavior is tracked in [iTerm2 issue 9619](https://gitlab.com/gnachman/iterm2/-/work_items/9619).

## Apple Terminal

Apex Code enables enhanced key reporting when available. If Terminal.app still sends plain Return for `Shift+Enter`, Apex Code uses a local macOS modifier fallback to treat that Return as `Shift+Enter`.

This fallback only works when Apex Code runs on the same Mac as Terminal.app. It cannot detect the local keyboard over remote SSH.

## Ghostty

Add this mapping to Ghostty's configuration if `Alt+Backspace` does not work:

```text
keybind = alt+backspace=text:\x1b\x7f
```

The configuration file is `~/Library/Application Support/com.mitchellh.ghostty/config` on macOS and `~/.config/ghostty/config` on Linux.

Older Claude Code configurations may contain:

```text
keybind = shift+enter=text:\n
```

That mapping sends a raw linefeed byte. Inside Apex Code, that is indistinguishable from `Ctrl+J`, so tmux and Apex Code no longer see a real `shift+enter` key event.

### Open links in fullscreen mode

Apex Code binds `Ctrl+J` as a default newline alias, so `Shift+Enter` keeps working in tmux via that remap without extra apex-code configuration.

### Fullscreen TUI mode

In fullscreen mode, links remain clickable, but Ghostty does not show its hover underline or lower-left URL preview while pi captures mouse input. Hold `Shift+Command` on macOS or `Shift+Ctrl` on Linux to use Ghostty's native link handling.

## WezTerm

WezTerm normally reports `Shift+Enter` through xterm extended keys. To enable the Kitty keyboard protocol explicitly, create `~/.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

On macOS, WezTerm binds `Option+Enter` to fullscreen by default. To use `Option+Enter` for Apex Code follow-up queueing, add this key override:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.keys = {
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}
return config
```

### Position an IME candidate window in WSL

On WSL, WezTerm may require a visible hardware cursor for IME candidate window positioning. If CJK IME candidates do not follow the text cursor, set `APEX_CODE_HARDWARE_CURSOR=1` before running Apex Code or set `showHardwareCursor` to `true` in settings. The temporary `PI_HARDWARE_CURSOR` alias also works.

## Alacritty

Alacritty usually works out of the box for `Shift+Enter`. On macOS, `Option+Enter` may arrive as plain `Enter`. To use `Option+Enter` for Apex Code follow-up queueing, add to `~/.config/alacritty/alacritty.toml`:

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

Restart Alacritty after changing the file.

## VS Code integrated terminal

VS Code 1.109.5 and newer enable the Kitty keyboard protocol in the integrated terminal by default.

For an older version, add a `Shift+Enter` terminal binding to `keybindings.json`:

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

The user `keybindings.json` file is normally located at:

- macOS: `~/Library/Application Support/Code/User/keybindings.json`
- Linux: `~/.config/Code/User/keybindings.json`
- Windows: `%APPDATA%\\Code\\User\\keybindings.json`

## Zed integrated terminal

Add these bindings to Zed's `keymap.json`:

```json
{
  "context": "Terminal",
  "bindings": {
    "shift-enter": ["terminal::SendText", "\u001b[13;2u"],
    "ctrl--": ["terminal::SendText", "\u001b[45;5u"],
    "ctrl-alt-]": ["terminal::SendText", "\u001b[93;7u"]
  }
}
```

## Windows Terminal

Apex Code uses Windows-style keybindings when running natively on Windows or in WSL:

- `Alt+V` pastes an image or clipboard text.
- `Ctrl+F` searches the transcript in fullscreen mode, and `Ctrl+Up`/`Ctrl+Down` jump between marked messages.
- `Alt+P` cycles to the previous model.
- `Ctrl+Z` undoes editing on native Windows; WSL uses `Alt+Z` so `Ctrl+Z` can suspend Apex Code.
- `Ctrl+Q` queues a follow-up message and `Alt+Q` restores queued messages.

Open Windows Terminal's `settings.json` with `Ctrl+Shift+,` or **Settings > Open JSON file**. Add this object to its `actions` array:

```json
{
  "command": { "action": "sendInput", "input": "\u001b[13;2u" },
  "keys": "shift+enter"
}
```

- `Shift+Enter` inserts a new line.
- Windows Terminal binds `Alt+Enter` to fullscreen by default. That prevents Apex Code from receiving `Alt+Enter` for follow-up queueing.
- Remapping `Alt+Enter` to `sendInput` forwards the real key chord to Apex Code instead, or configure Windows Terminal to send the key and bind `app.message.followUp` to `alt+enter` in Apex Code to use it instead of the `Ctrl+Q` default.

### Use Alt+Enter for follow-ups

Windows Terminal binds `Alt+Enter` to fullscreen by default. Pi therefore uses `Ctrl+Q` for follow-ups on Windows and WSL.

To use `Alt+Enter` instead, configure Windows Terminal to forward the key and bind `app.message.followUp` to `alt+enter` in Pi's `keybindings.json`. See [Keybindings](keybindings.md#assign-keybindings).

## xfce4-terminal and Terminator

These terminals cannot reliably distinguish modified Enter keys from plain `Enter`. Custom bindings such as `Ctrl+Enter` or `Shift+Enter` therefore may not work.

Use a terminal with modern extended-key support when you need those shortcuts, such as Kitty, Ghostty, WezTerm, iTerm2, Windows Terminal, or a compatible Alacritty build.

If you want the hardware cursor visible, set `APEX_CODE_HARDWARE_CURSOR=1` before running Apex Code (disabled by default for compatibility; the temporary `PI_HARDWARE_CURSOR` alias also works).

IntelliJ IDEA's built-in terminal cannot reliably distinguish `Shift+Enter` from plain `Enter`. Use `Ctrl+J` for a newline or run Pi in a terminal with modern extended-key support.

If an IME candidate window does not follow the text cursor, show the hardware cursor:

```bash
export PI_HARDWARE_CURSOR=1
pi
```

## Override detected capabilities

Pi automatically detects OSC 8 hyperlinks, inline image protocols, and truecolor support. A terminal proxy or multiplexer can make that detection inaccurate.

| Capability | Environment variable | Setting |
|---|---|---|
| Hyperlinks | `PI_HYPERLINKS=1\|0\|auto` | `terminal.hyperlinks: true\|false\|"auto"` |
| Inline images | `PI_IMAGE_PROTOCOL=kitty\|iterm2\|none\|auto` | `terminal.images: "kitty"\|"iterm2"\|false\|"auto"` |
| Truecolor | `PI_TRUE_COLOR=1\|0\|auto` | `terminal.trueColor: true\|false\|"auto"` |

Settings take precedence over environment variables. An unset value or `auto` preserves automatic detection.

Only force a capability supported by the complete terminal path. Unsupported escape sequences can corrupt rendering. See [Environment Variables](environment-variables.md#pi-process-configuration) and [Settings](settings.md) for the canonical value definitions.
