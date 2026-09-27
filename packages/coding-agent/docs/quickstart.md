# Quickstart

This page gets you from install to a useful first Apex Code session.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

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

The working folder helps Apex Code discover relevant files, instructions, and configuration. Apex Code also uses it to group saved sessions.

Apex Code can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use Apex Code in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

Start Apex Code and run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward if you want to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

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
Summarize @meeting-notes.md and save the action items to action-items.md.
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
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When Apex Code finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

Apex Code saves sessions automatically. Exit Apex Code, then resume the most recent session for the same working folder with:

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

### Choose how to customize Apex Code

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give Apex Code persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [Apex Code package](packages.md) |

## Update or uninstall Apex Code

Update Apex Code with your package manager:

```bash
npm install --global apex-code
```

To uninstall an npm installation, run:

```bash
npm uninstall --global apex-code
```

Uninstalling leaves configuration, credentials, sessions, and installed packages in `~/.apex-code/agent/`.
