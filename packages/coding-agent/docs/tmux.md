# Run Pi in tmux

Apex Code works inside tmux, but tmux strips modifier information from certain keys by default. Without configuration, `Shift+Enter` and `Ctrl+Enter` are usually indistinguishable from plain `Enter`.

## Check your tmux version

```bash
tmux -V
```

For tmux 3.5 or newer, use the recommended CSI-u configuration below. For tmux 3.2 through 3.4, use the older-version configuration.

## Enable extended keys in tmux 3.5 or newer

Add these lines to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

Pi requests extended-key reporting when the terminal does not provide the Kitty keyboard protocol directly. CSI-u is the most reliable format for forwarding modified keys through tmux.

## Restart tmux

The configuration applies to the tmux server. To guarantee that it is active, close your tmux sessions and start a new server.

If you choose to stop the server from the command line, save your work first. This command terminates every session managed by that server:

```bash
tmux kill-server
tmux
```

Apex Code requests extended key reporting automatically when Kitty keyboard protocol is not available. With `extended-keys-format csi-u`, tmux forwards modified keys in CSI-u format, which is the most reliable configuration. The `extended-keys-format` option requires tmux 3.5 or later.

Start Pi inside the new tmux session and check that:

1. `Shift+Enter` inserts a new line in the editor.
2. `Enter` submits the prompt.
3. `Alt+Enter` queues a follow-up on macOS and Linux. Windows and WSL use `Ctrl+Q` by default.

If these keys still behave like plain `Enter`, verify that the terminal outside tmux can report modified keys. See [Configure your terminal](terminal-setup.md).

## Use tmux 3.2 through 3.4

These versions support extended keys but not `extended-keys-format csi-u`. Add only:

```tmux
set -g extended-keys on
```

Pi supports the xterm `modifyOtherKeys` format used by these versions. Restart tmux and repeat the verification steps.

- `Ctrl+C` → `\x1b[27;5;99~`
- `Ctrl+D` → `\x1b[27;5;100~`
- `Ctrl+Enter` → `\x1b[27;5;13~`

With `extended-keys-format csi-u`, the same keys are forwarded as:

- `Ctrl+C` → `\x1b[99;5u`
- `Ctrl+D` → `\x1b[100;5u`
- `Ctrl+Enter` → `\x1b[13;5u`

Apex Code supports both formats, but `csi-u` is the recommended tmux setup.

## What This Fixes

Without tmux extended keys, modified Enter keys collapse to legacy sequences:

| Key | Without extkeys | With `csi-u` |
|-----|-----------------|--------------|
| Enter | `\r` | `\r` |
| Shift+Enter | `\r` | `\x1b[13;2u` |
| Ctrl+Enter | `\r` | `\x1b[13;5u` |
| Alt/Option+Enter | `\x1b\r` | `\x1b[13;3u` |

This affects the default keybindings (`Enter` to submit, `Shift+Enter` for newline) and any custom keybindings using modified Enter.

## Requirements

- tmux 3.5 or later for `extended-keys-format csi-u` (run `tmux -V` to check)
- A terminal emulator that supports extended keys (Ghostty, Kitty, iTerm2, WezTerm, Windows Terminal)

With tmux 3.2 through 3.4, omit `extended-keys-format csi-u`; Apex Code still supports tmux's default xterm `modifyOtherKeys` format.
