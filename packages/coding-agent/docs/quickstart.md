# Quickstart

This page gets you from install to a useful first Apex Code session.

## Install

Apex Code is distributed as an npm package and installs the same way with npm, pnpm,
Yarn, or Bun — all four resolve it from the same npm registry:

```bash
# npm
npm install -g --ignore-scripts apex-code

# pnpm
pnpm add -g apex-code

# Yarn
yarn global add apex-code

# Bun
bun add -g apex-code
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Apex Code does
not require install scripts for normal npm installs; pnpm, Yarn, and Bun installs do not
run them by default.

Apex Code does not operate a separate shell/curl installer or a standalone binary release
channel — the package manager install above is the only distribution channel.

### Uninstall

Use the package manager that installed Apex Code:

```bash
# npm
npm uninstall -g apex-code

# pnpm
pnpm remove -g apex-code

# Yarn
yarn global remove apex-code

# Bun
bun uninstall -g apex-code
```

Uninstalling Apex Code leaves settings, credentials, sessions, and installed Apex Code
packages in `~/.apex-code/agent/`.

Then start Apex Code in the project directory you want it to work on:

```bash
cd /path/to/project
apex-code
```

## Authenticate

Apex Code can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start Apex Code and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching Apex Code:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
apex-code
```

You can also run `/login` and select an API-key provider to store the key in `~/.apex-code/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once Apex Code starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, Apex Code gives the model four tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. Apex Code runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give Apex Code project instructions

Apex Code loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Apex Code loads:

- `~/.apex-code/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

If a directory contains `AGENTS.override.md`, Apex Code loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory.

Restart Apex Code, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
apex-code @README.md "Summarize this"
apex-code @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
apex-code -c                  # Continue most recent session
apex-code -r                  # Browse previous sessions
apex-code --name "my task"    # Set session display name at startup
apex-code --session <path|id> # Open a specific session
```

Inside Apex Code, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
apex-code -p "Summarize this codebase"
cat README.md | apex-code -p "Summarize this text"
apex-code -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Apex Code](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Apex Code Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
