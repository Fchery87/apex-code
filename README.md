# Apex Code

A provider-agnostic agentic coding harness for working with real repositories from the
terminal. Apex Code can inspect a codebase, explain it, make changes, run commands,
coordinate bounded subagents, preserve a resumable session, and record evidence about
what actually happened.

Apex Code is a fork of Pi's coding-agent and agent-core layers, with a deliberate
boundary around the upstream provider and terminal foundations. It keeps the breadth of
Pi's provider layer while adding a safety floor, a larger tool surface, durable state,
verification evidence, and operational visibility.

> **Status: stable — Phases 0 through 12 have landed.** Releases carry
> the ordinary compatibility expectations of a published package, and a removal ships with
> its migration stated ([ADR 0033](docs/adr/0033-stable-release-line.md)). The `0.x` major
> still signals that the shape of the product is moving. The [roadmap](docs/roadmap.md)
> records what is implemented and how each phase was verified.

## Contents

- [Install](#install)
- [Set up your first provider](#set-up-your-first-provider)
- [Start your first session](#start-your-first-session)
- [How Apex Code works](#how-apex-code-works)
- [Safety model](#safety-model)
- [Sessions, state, and evidence](#sessions-state-and-evidence)
- [Models and providers](#models-and-providers)
- [Common workflows](#common-workflows)
- [Extensions and customization](#extensions-and-customization)
- [Network and privacy](#network-and-privacy)
- [Configuration and environment variables](#configuration-and-environment-variables)
- [Troubleshooting](#troubleshooting)
- [Developing Apex Code](#developing-apex-code)
- [Project documentation](#project-documentation)

## Install

### Requirements

- **Node.js 22.19.0 or newer.** Check your version with `node --version`.
- **npm**, normally installed with Node.js.
- A model provider account or API key. Apex Code does not provide model access or
  bundle provider credentials.
- Linux, macOS, and Windows are supported targets. Apex Code ships no built-in
  sandbox, so run it inside a container or VM for untrusted work. See
  [Isolation](#isolation).

### Install from npm

`latest` names the newest stable release and a plain install resolves it (ADR 0026). It
installs the same way with npm, pnpm, Yarn, or Bun — all resolve it from the same npm
registry:

```bash
npm install --global apex-code      # npm
pnpm add --global apex-code         # pnpm
yarn global add apex-code           # Yarn
bun add --global apex-code          # Bun

apex-code --version
```

The command installs the `apex-code` executable globally. To update an existing npm
installation, use the same npm channel:

```bash
npm install --global apex-code
# or from an existing installation:
apex-code update
```

If your system does not permit global npm writes, use a Node version manager, configure
npm's global prefix, or run Apex Code through a project-local installation. Do not use
`sudo` unless you understand and intentionally accept the permissions and ownership
implications for your Node installation.

### Install the standalone binary from GitHub Releases

If you prefer not to install Node.js, Apex Code also publishes standalone archives for
macOS (Apple Silicon and Intel), Linux (x64 and ARM64), and Windows (x64 and ARM64).
The installers download the matching GitHub Release archive, verify it against that
release's SHA-256 manifest before extracting it, install it only for your user account,
and add its command directory to your user `PATH`.

On macOS, Linux, or **Git Bash on Windows**:

```bash
curl -fsSL https://raw.githubusercontent.com/Fchery87/apex-code/main/install.sh | bash
```

On PowerShell (including Windows Terminal):

```powershell
irm https://raw.githubusercontent.com/Fchery87/apex-code/main/install.ps1 | iex
```

Close and reopen the terminal after installation, then verify it:

```bash
apex-code --version
```

To install one specific release rather than the latest GitHub Release, set the version
in the receiving shell:

```bash
curl -fsSL https://raw.githubusercontent.com/Fchery87/apex-code/main/install.sh | APEX_CODE_INSTALL_VERSION=0.8.0 bash
```

```powershell
$env:APEX_CODE_INSTALL_VERSION = "0.8.0"; irm https://raw.githubusercontent.com/Fchery87/apex-code/main/install.ps1 | iex
```

The standalone channel does not require Node.js and does not update itself; re-run the
installer to choose a newer GitHub Release. The CLI and both Windows installers are
supported portability paths.

### Install from this repository

This path is for contributors and people testing unreleased changes:

```bash
git clone https://github.com/Fchery87/apex-code.git
cd apex-code
npm install
npm run build
npx tsx --tsconfig tsconfig.runtime.json packages/coding-agent/src/cli.ts --version
```

The repository is an npm workspace. `npm install` installs the workspace dependencies;
`npm run build` builds the consumed foundations and the Apex-owned packages in dependency
order. The development command above runs the TypeScript entry point without installing
a global executable.

## Set up your first provider

Apex Code is provider-agnostic: you choose the model service and credentials. The
simplest setup is interactive:

```bash
apex-code
```

Inside the session, run:

```text
/login
```

Choose a provider and follow its API-key or OAuth flow. You can then inspect available
models with:

```text
/model
```

To verify credentials without starting an interactive session:

```bash
apex-code auth check --provider anthropic
```

Replace `anthropic` with the provider you use. Provider-specific API-key names,
subscription sign-in instructions, OAuth notes, and the supported provider table are in
[`packages/coding-agent/docs/providers.md`](packages/coding-agent/docs/providers.md).

You can also provide a key through the provider's environment variable. For example:

```bash
export ANTHROPIC_API_KEY="your-key"
apex-code --provider anthropic
```

Do not put real credentials in a tracked file, shell history, issue, session transcript,
or prompt. Apex Code stores credentials in its local credential store when you use
`/login`; it does not write provider keys into the configuration files it manages.

## Start your first session

From the repository you want to work on:

```bash
cd path/to/your/project
apex-code
```

Two sessions in one checkout overwrite each other's edits. Start the second one in its own worktree:

```bash
apex-code --worktree <name>
```

The flag creates `.apex-code/worktrees/<name>` on branch `apex-session-<name>` and starts the session there. On exit, a clean tree is removed. A dirty tree is kept, and the message names its path. The name has to be one path component. `..` and a leading dash are refused. The flag does not copy gitignored files such as `.env`, and it does not block a command whose path points at the parent checkout.

Give Apex Code an initial task directly on the command line, or start the session and
write it in the editor:

```bash
apex-code "Explain the architecture of this repository and suggest the safest first change"
apex-code @prompt.md "Implement this change and run the relevant tests"
```

Useful first-session commands include:

```text
/help       Show interactive commands
/config     Search common settings, model, provider, trust, and resource controls
/model      Browse and select an available model
/login      Configure provider credentials
/session    Inspect the current session and usage
/tree       Navigate branches in the session tree
/export     Export the session locally to HTML
/share      Confirm and publish a session as a secret GitHub Gist
```

`/config` keeps the existing commands and selectors canonical. Its resource, extension,
and MCP-adapter entry opens the existing package-resource manager through
`apex-code config`, rather than duplicating that configuration surface in a session.

Start in a cautious mode when you are learning the tool or reviewing an unfamiliar
repository:

```bash
# Ask before operations that are not already allowed
apex-code --permission-mode default

# Planning/read-only posture; mutating operations are blocked
apex-code --permission-mode plan

# Non-interactive invocation; always choose an explicit permission mode
apex-code --permission-mode plan --print "Review the authentication flow and list risks"
```

For the complete flag reference:

```bash
apex-code --help
```

### Interactive keys and modes

- `Shift+Tab` cycles the permission mode for this session only. The footer marks a session
  override. `/settings` still sets the saved default.
- `Alt+T` cycles the thinking level.
- `Alt+J` or `/tasks` shows or hides the task panel.
- `Esc` interrupts the running turn, including a foreground subagent.
- In plan mode, `plan_present` offers three choices: approve and accept edits, approve and ask
  before edits, or keep planning. Approving switches the permission mode.
- In `/tree`, restoring files asks first when the workspace differs from the checkpoint. Keeping
  the current files is the default.

## How Apex Code works

Apex Code is an agent loop surrounded by policy, state, and verification layers. A
normal turn follows this shape:

1. **Build context.** Apex Code combines the system prompt, session history, project
   context files such as `AGENTS.md`, the current request, enabled tools, and relevant
   extension state. A project's own `AGENTS.md` or `CLAUDE.md` is instruction the
   repository supplies, so it loads only once you have trusted that project; the one in
   your agent directory is yours and always loads. `apex-code instructions audit` reads
   `AGENTS.md` and `CLAUDE.md`, prints a path that does not exist, a command that is not on
   `PATH`, and the same command with two different argument lists, and writes no file. It
   exits 1 when it finds one.
2. **Select a model.** The configured provider/model and reasoning level determine which
   upstream `pi-ai` adapter receives the request.
3. **Ask for the next action.** The model can answer directly or request a tool call.
4. **Check policy.** The tool's declared contract is evaluated against permission rules,
   project trust, and the active permission mode before execution.
5. **Run the tool.** File, search, shell (foreground and background), network, question,
   planning, and delegation tools perform the requested operation.
6. **Capture the result.** The tool returns structured output and, where applicable,
   evidence such as an exit code, argv, patch hash, or test result.
7. **Continue or finish.** The result is added to context; the model may request another
   action, ask a question, or produce a final response.
8. **Persist the session.** Messages, tool calls, model changes, and state transitions
   are written to a JSONL session tree so the work can be resumed, branched, inspected,
   and exported.

The loop is intentionally extensible. Extensions can intercept tool calls, transform
context, register tools and commands, add providers, and render custom UI. They extend
the same permission and session machinery rather than bypassing it.

### Built-in tools and subagents

A new session starts with these tools active: `read`, `bash`, `edit`, `write`, `grep`,
`find`, `ls`, `web_fetch`, `delegate`, and `memory_note`. Search and fetch are on by default, and each
still asks through its own permission rule. `lsp`, `web_search`, and `mcp` join when they
are configured. `browser` joins when `browser.enabled` is true in the user settings file.
A project settings file cannot turn it on. `todo_write` (the task list) and `ask_user` stay opt-in. Turn the task list
on in `/settings`. A saved `defaultTools` setting replaces the default set.

`memory_note` appends a markdown note to `.apex-code/memory/inbox/`. The next session does not
load that note. Accepting it moves the file to `.apex-code/memory/accepted/`, and only accepted
notes load, after you trust the project. Loading stops at 200 lines or 25 KB. A note whose body
contains `api_key=`, `token=`, `password=`, or a PEM private key is refused and not written.
Every worktree of one git repo reads the same notes.

A file under `.apex-code/rules/` with a `paths` glob in its frontmatter is not loaded at startup.
`read`, `edit`, and `write` append its body when the path matches.

`browser` opens one `http` or `https` URL on `localhost`, `127.0.0.1`, or `::1`. It returns the
page title, the console, and one screenshot. Any other host is refused before a browser starts.
The tool does not click, type, or follow a second URL. It launches a headless Chrome or Chromium
already on the machine, with an empty temporary profile, and it does not attach to the browser
you have open. A missing binary returns the path and `ENOENT`.

`delegate` runs a subagent with its own context. Two built-in types ship:

- `explore` reads, searches, and lists files. It cannot edit files or run commands.
- `general` has the default file and shell tools. It cannot delegate further.

A definition in `~/.apex-code/agent/agents/` or, in a trusted project, `.apex-code/agents/`
with the same name replaces a built-in. Press `Esc` to interrupt a foreground subagent.
A background subagent keeps running.

### Architecture at a glance

```
Your terminal / SDK / RPC client
              │
              ▼
Apex Code CLI and session runtime
  tools · permissions · trust · sessions · compaction · delegation · evidence
              │
              ▼
Apex agent core
  model loop · steering/follow-up · interception · context pipeline
              │
              ▼
Consumed upstream foundations
  pi-ai: providers and model APIs     pi-tui: terminal UI primitives
```

Apex Code owns the layers above the dependency boundary. It forks `pi-coding-agent` and
`pi-agent-core`; it consumes `pi-ai` and `pi-tui` as ordinary upstream dependencies and
does not patch them. This keeps provider coverage broad and makes upstream merges
possible without turning every provider into Apex-owned code. See [ADR 0001](docs/adr/0001-fork-boundary.md).

## Safety model

Apex Code is a local coding agent. It can read and write files and execute commands with
the permissions of the user who starts it. No harness can make arbitrary model output
safe by itself; the safety model is designed to make actions visible, constrained, and
reviewable.

### Permission gate

Every built-in and extension tool declares a contract covering its capabilities,
permission grammar, context behavior, and evidence. Tool calls pass through a common
permission gate before they execute. Rules can be scoped and persisted according to
their source; the tool, not a separate classifier, interprets tool-specific rule
content.

Permission modes change the default interaction posture:

- `default` asks for operations that policy does not already allow.
- `plan` blocks mutating operations while you investigate or design a change. Its tool
  set is the read-only tools plus `grep`, `find`, `ls`, and `plan_present`.
- `acceptEdits` auto-allows file edits whose target stays inside the workspace, and still
  asks for an edit that leaves it, for commands, and for network access.
- `dontAsk` declines operations that would require an interactive decision.
- `bypassPermissions` is intentionally powerful and should be used only in a trusted,
  controlled environment.

Set one for a single run with `--permission-mode <mode>`, or change it mid-session from
`/settings` under **Permission mode**. The settings row saves to user scope
(`~/.apex-code/agent/permissions.json`) and takes effect on the next tool call; selecting
`bypassPermissions` asks you to confirm first. A mode set by `--permission-mode` or by a
project's `.apex-code/permissions.json` outranks that write, and the row says so rather
than appearing to save and doing nothing. Any mode other than `default` is named in the
footer, so a session with no prompts is visibly a session in bypass.

A permission mode is not a substitute for reviewing the requested task, the diff, or the
commands that will run.

**A permission mode governs the tool gate, not OS containment.** The two are separate
layers. `bypassPermissions` stops the gate asking; it does not change what the invoking
account is allowed to do on the machine. A tool call waved through by `bypassPermissions`
can still do anything that account can do.

Settings can also declare hooks: commands or HTTP endpoints attached to lifecycle events.
A hook's output can return an allow, block, or ask decision, and that decision feeds the
same permission gate. Hooks are absent until you configure them under a `hooks` key in
settings.

### Reads, credentials, and edits

**Reads outside the workspace ask.** The workspace is the directory the session started in
and everything beneath it, not the enclosing git repository. `read`, `grep`, `find`, and
`ls` ask before they reach a target outside it. "Always allow" saves a rule for that
target's directory and everything beneath it, not for one file. A symlink that points
outside the workspace counts as outside.

**Credential locations are protected.** `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`,
`~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, and Apex Code's own `auth.json`
are protected in every mode. A read of one asks first, and with no one to answer, it is refused.
The machine owner's managed policy can grant them, and the interactive responder can approve an
individual call. No user or project rule can grant them.

**Sensitive files ask.** A project's `.env` and `.env.<suffix>` files ask by default. Only
a rule that names the file grants one, such as `**/.env`. A rule for its directory does not.
The template names `.env.example`, `.env.sample`, and `.env.template` are ordinary files.

**Read-only commands run without a prompt.** In `default` mode, `pwd`, `--version` for git,
node, npm, rg, and python3, and the listed read-only forms of `git status`, `log`, `diff`,
`branch`, `show`, and `rev-parse` run without asking. A flag outside the list, a path outside
the repository, a git option before the subcommand, or a chain of commands makes the call ask.

**Edits need a read first.** `write` refuses to replace an existing file the model has not
read in full in this session. `edit` refuses a file that changed on disk since it was read,
and a partial read satisfies `edit` but not `write`. A resumed session starts with no reads,
so the first write asks the model to read the file again.

### Isolation

Apex Code ships no built-in sandbox. Built-in tools, extensions, and package installs run
with the permissions of the account that started the CLI. There is no OS-level boundary
between the session and the rest of the machine.

The permission gate is still real and still applies to every tool call. It is a policy
layer, not a containment boundary, and it is not a substitute for OS isolation.

For an untrusted repository, generated code you will not review, or unattended runs, run
the CLI inside a container, VM, dev container, or remote sandbox with only the files and
credentials the task needs. For example, with Docker:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -w /workspace \
  -e ANTHROPIC_API_KEY \
  node:22 \
  npx apex-code
```

Restrict the mounts and the credentials to what the task needs. Windows container and VM
isolation works the same way.

An extension can add a boundary inside the session, but read what it covers before you
rely on it. `packages/coding-agent/examples/extensions/sandbox/` replaces the `bash` tool
only, so its `denyRead` list does not apply to `read`, `grep`, `find`, or `ls`, which reach
the filesystem in-process. ADR 0005 declined that shape for the harness itself for this
reason. `examples/extensions/gondolin/` re-creates the file tools as well and is the
closer model. Either way the container is what actually holds; see
[`docs/containerization.md`](packages/coding-agent/docs/containerization.md).

`bashConfinement` set to `"on"` in the user settings file is a smaller option. It wraps
`bash` with `bwrap` on Linux and refuses the call when `bwrap` is missing. It does
not wrap `read`, `grep`, `find`, `ls`, `edit`, `write`, or extensions. With `bwrap` present,
the command runs with `--unshare-net`, so it has no network, including loopback. There is
no host allowlist. macOS `sandbox-exec` is not implemented. It does not
replace the container for an untrusted repo. A project settings file cannot turn it
on or off. See [ADR 0038](docs/adr/0038-optional-bash-confinement.md).

Read [`SECURITY.md`](SECURITY.md) before relying on Apex Code for higher-risk work.

### Verification and formatter policies

The `policies` settings key defines named commands the session may run for verification
and formatting. Each policy pins one executable and its exact argv, and no policy runs
through a shell. A formatter policy may write only the paths it declares. Verification
runs only when requested unless `policies.boundary` is set to `"post-turn"`, and a failed
check adds a warning unless the policy sets `blocksCompletion`. ADR 0030 records the
authority model behind these limits.

### Project trust and extensions

Project trust controls whether project-local configuration, skills, and extensions are
loaded. It is not a sandbox and it does not reduce permissions once a turn is running.
Extensions execute as TypeScript in the Apex Code process with that process's privileges;
only install or enable extensions you trust.

## Sessions, state, and evidence

Apex Code stores state under `~/.apex-code/agent/` by default. The main locations are:

| Location | Contents |
| --- | --- |
| `auth.json` | Provider credentials and OAuth state, protected as local user data |
| `settings.json` | User preferences and enabled resources |
| `models.json` | Model/provider configuration |
| `models-store.json` | Explicitly configured remote catalog cache |
| `sessions/` | JSONL conversation trees and branches |
| `extensions/` | Global extensions |
| `skills/` | Global skills |
| `prompts/` | Global prompt templates |
| `themes/` | Global themes |
| `tools/` | User tools and supporting resources |
| `state.sqlite` | Usage and cost records, background command records, and session leases. It runs in WAL mode, so several processes can share it. |

Project-local resources live under `.apex-code/`, including project settings,
extensions, skills, prompts, and other repository-specific configuration. Keep local
Apex state out of source control unless you intentionally maintain a sanitized,
reviewable project configuration. Never commit `auth.json`, session files containing
sensitive content, or generated evidence that includes secrets.

Sessions are JSONL files whose entries form a tree through parent and entry IDs. This
means you can branch in place instead of creating a new transcript for every experiment:
`/tree` navigates branches, `/fork` creates a new branch, and `--continue` or `--resume`
returns to prior work.

Session files are readable only by your user (`0600`), and their directories are `0700` on
POSIX systems. Files that an earlier version created are tightened when they are opened.

In a git repository, worktree checkpoints are on by default. Apex Code records the
worktree as the session changes it, so an earlier state can be restored after a bad edit.
Set `"checkpoints": { "enabled": false }` in `settings.json` to turn them off.

Evidence is captured at the source of an operation. For example, the bash tool knows its
actual argv and exit code, and edit/write tools can record patch information. The result
is stronger than asserting that a command passed based only on rendered text. The
optional cost and latency store powers:

```bash
apex-code cost
```

## Models and providers

The provider layer is not tied to one vendor. Apex Code consumes Pi's `pi-ai` provider
layer, which supports a broad set of providers and API dialects. Depending on the
provider, credentials may be configured through OAuth, an API key in `/login`, or an
environment variable. Provider names and model IDs are intentionally provider-native;
those identifiers are part of compatibility rather than Apex branding.

Model selection examples:

```bash
apex-code --provider openai --model gpt-4o-mini
apex-code --model openai/gpt-4o
apex-code --thinking high "Solve this complex problem"
apex-code --list-models
```

Built-in model metadata is bundled with the provider dependency and works without a
hosted catalog. An optional remote catalog overlay is used only when you explicitly set
`APEX_CODE_MODEL_CATALOG_URL`. Set `APEX_CODE_OFFLINE=1` or pass `--offline` to disable
startup network operations.

## Common workflows

### Review without changing files

```bash
apex-code --permission-mode plan --tools read,grep,find,ls \
  --print "Review src/ for security and correctness risks"
```

### Make a change and verify it

```bash
apex-code "Implement the requested change, run the narrowest relevant tests, then summarize the diff and verification"
```

Review the diff and test output yourself before committing. Apex Code is an assistant,
not an autonomous approval system.

### Resume or branch work

```bash
apex-code --continue
apex-code --resume
apex-code --session path/to/session.jsonl
apex-code --fork path/to/session.jsonl
```

### Run a long command in the background

Ask the `bash` tool for `background: true` to start a command and get a handle back at once.
Retrieve its output with `{ "handle": "..." }`, and stop it with `{ "handle": "...", "kill": true }`.
Each background command is recorded in `state.sqlite` before its process starts. If Apex Code
exits while one is running, the next session marks it `interrupted` rather than reporting it as
completed. A background command is refused, not run unrecorded, when its record cannot be written.

### Run without saving a session

```bash
apex-code --no-session --permission-mode plan --print "Explain this file"
```

### Use machine-readable integration modes

```bash
apex-code --mode json --permission-mode plan --print "Summarize the repository"
apex-code --mode rpc
```

Use JSON/RPC when another process owns orchestration. The permission mode must be
explicit for non-interactive modes, and secrets should be kept out of prompts and
captured output.

`--print` and `--mode json` exit `0` only when the run completed. A provider error, a
cancelled run, and an exhausted `runBudget` each exit `1`. `--mode rpc` and `--mode acp`
own their own lifecycles and are unaffected. A `--mode json` run that reaches a normal
terminal outcome ends with a `result` envelope naming which of those happened, so a caller
can branch on the cause rather than on the exit code alone. See
[JSON event stream mode](packages/coding-agent/docs/json.md#result-envelope-and-exit-codes).

`--mode acp` speaks the Agent Client Protocol over stdio JSON-RPC, which connects Apex
Code to ACP clients such as Zed and the JetBrains IDEs.

### Share a session deliberately

`/share` first asks for confirmation, then exports the complete session HTML and creates
a **secret Gist** through the GitHub CLI. Secret means unlisted, not private or
access-controlled; anyone with the URL can read it. The upload runs your authenticated
GitHub CLI with your host credentials. The export can contain
prompts, tool calls and results, paths, and file content. Credential-shaped strings such as provider keys, GitHub and AWS tokens, and PEM private keys
are replaced before upload, and the confirmation states how many were replaced. Use `/export`
to inspect a local copy first. By default Apex Code returns the GitHub Gist URL; configure
`APEX_CODE_SHARE_VIEWER_URL` only for a viewer you explicitly trust.

## Extensions and customization

Extensions are TypeScript modules that can register tools, commands, providers, flags,
shortcuts, event handlers, and custom UI. A minimal extension can live at
`~/.apex-code/agent/extensions/hello.ts`:

```typescript
import type { ExtensionAPI } from "apex-code";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Hello from Apex Code", "info");
    },
  });
}
```

Load a one-off extension with:

```bash
apex-code --extension ./hello.ts
```

Project-local extensions belong in `.apex-code/extensions/` and load only after project
trust permits them. Global extensions belong in `~/.apex-code/agent/extensions/`. An
extension has the privileges of the Apex Code process; review its source before loading
it. See [`packages/coding-agent/docs/extensions.md`](packages/coding-agent/docs/extensions.md)
for lifecycle events, tools, UI, packages, and examples.

### MCP servers

A project's `.mcp.json` configures Model Context Protocol servers, and the resource
manager in `apex-code config` manages them alongside other package resources. A server
configured with `"auth": "oauth"` needs a one-time authorization:

```bash
apex-code mcp auth <server-name>
```

The command opens the OAuth flow in a browser and stores the tokens in the local
credential store, never in the project.

A stdio MCP server starts with the SDK's safe default environment, not your full environment.
To pass a variable to it, reference the variable in the server's `env` entry:
`"GITHUB_TOKEN": "$GITHUB_TOKEN"`. `${NAME}` works too. Write a literal dollar sign as `$$`.
`!command` runs a command and is allowed in a project `.mcp.json`. A server that exits during
startup gets a hint that names this syntax.

Lazy servers are started once at startup to list their tools, so search finds their tools in
the first session. Apex Code reports which servers it started. Set `mcpStartupDiscovery` to
`false` to skip this.

## Network and privacy

Apex Code sends no project-directed usage telemetry. At startup it may query npm for the
`apex-code` version; disable that request with:

```bash
APEX_CODE_SKIP_VERSION_CHECK=1 apex-code
```

`--offline` implies the same skip.

Model requests go to the provider you select. Optional OTLP traces are sent only to an
endpoint you explicitly configure, using an allowlist that excludes prompts, messages,
tool arguments, tool results, file paths, workspace paths, and environment values.

`web_fetch` fetches the URLs the model requests, after the usual permission check. Only `http`
and `https` are allowed. It refuses loopback, private, link-local, and unique-local addresses
after DNS resolution, and it connects to the address it checked. To reach an intranet host,
set `webFetch.allowPrivateNetwork` in your user settings. When an HTTP proxy is configured,
`web_fetch` refuses to fetch unless `webFetch.allowProxiedFetch` is set in user settings,
because the proxy resolves the destination and cannot be pinned to the address that was
checked. A redirect to another host is not followed; the target is returned for a separate,
permission-checked fetch. Responses are read up to 5 MB and converted from HTML to Markdown.
Both settings are read from user settings only, so a project cannot enable them.

The default model catalog is local. The `/share` viewer is not a default hosted service;
`APEX_CODE_SHARE_VIEWER_URL` is an explicit opt-in endpoint. The npm registry, your model
provider, GitHub when you explicitly publish an export as a gist, and any configured
integration can still receive data required for that operation. Read the destination's
policies and review sensitive content before sending it.

## Configuration and environment variables

Apex-owned runtime variables use the `APEX_CODE_*` prefix:

| Variable | Purpose |
| --- | --- |
| `APEX_CODE_CODING_AGENT_DIR` | Override the main config/state directory |
| `APEX_CODE_CODING_AGENT_SESSION_DIR` | Override session storage |
| `APEX_CODE_OFFLINE` | Disable startup network operations |
| `APEX_CODE_SKIP_VERSION_CHECK` | Disable the npm prerelease version check |
| `APEX_CODE_MODEL_CATALOG_URL` | Explicit remote model-catalog base URL |
| `APEX_CODE_SHARE_VIEWER_URL` | Explicit share-preview base URL |
| `APEX_CODE_EXPERIMENTAL` | Enable experimental features |
| `APEX_CODE_PACKAGE_DIR` | Override package assets for Nix/Guix-style installs |
| `EDITOR`, `VISUAL` | External-editor selection fallback |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Temporary `PI_*` aliases remain for bounded compatibility through the pre-1.0 window.
When both names are set, the canonical `APEX_CODE_*` value wins; legacy-only use emits
a deprecation diagnostic. See the complete
[`environment variable reference`](packages/coding-agent/docs/environment-variables.md)
for subprocess metadata and all controls.

### Settings added or changed in 0.7.0

| Setting | Where | Effect |
| --- | --- | --- |
| `defaultTools` | settings | Replaces the default tool set for new sessions. A saved list still wins. |
| `webFetch.allowPrivateNetwork` | user settings | Lets `web_fetch` reach loopback and private addresses. Default off. |
| `webFetch.allowProxiedFetch` | user settings | Lets `web_fetch` run through a configured HTTP proxy. Default off. |
| `mcpStartupDiscovery` | settings | Starts lazy MCP servers at startup to list their tools. Default on. |
| `compaction.outputReserveFraction` | settings | Caps the output-limit part of the compaction reserve at this share of the context window. Default one third. |

## Troubleshooting

### `apex-code: command not found`

The npm global bin directory is not on your `PATH`. Check `npm prefix --global`, add its
`bin` directory to your shell's `PATH`, or use a Node version manager and reinstall.

### The first run cannot find a model

Run `/login`, confirm the provider name, and inspect available models with `/model` or
`apex-code --list-models`. For API-key providers, verify the exact provider environment
variable from the [provider reference](packages/coding-agent/docs/providers.md).

### A request fails before the model responds

Check provider credentials, provider/model selection, network/proxy settings, and
`APEX_CODE_OFFLINE`. Use `apex-code auth check --provider <provider>` before changing
permission settings; authentication and tool permissions are separate concerns.

### Apex Code asks for too many permissions

Start with `--permission-mode plan` to understand the task without mutations. Then add
narrow, reviewable rules or use `default` and approve only the operations you understand.
Avoid `bypassPermissions` for repositories or credentials you do not fully trust.

### I need to inspect a session without sending it anywhere

Use `/export` for a local HTML export. Do not use `/share`; that explicitly uploads the
complete export to GitHub after confirmation.

### I am working on an untrusted repository

Use a container, VM, or micro-VM, restrict mounts and network access, use short-lived
credentials, and review outputs before moving them into a trusted environment. Apex Code
ships no built-in sandbox, so container or VM isolation is the containment boundary.

Declining the trust prompt, or answering it later, keeps that repository's settings,
permission grants, agents, eager MCP servers, and `AGENTS.md` or `CLAUDE.md` out of the
session. It is not containment and does not stop a tool call you approve. It stops the
checkout from configuring the agent before you have looked at it.

### `web_fetch` refuses an address

The address is loopback, private, link-local, or unique-local, or it resolves to one of those.
For an intranet host, set `webFetch.allowPrivateNetwork` in your user settings. A project cannot
set it.

### `web_fetch` refuses because a proxy is configured

The proxy resolves the destination, so the address that was checked cannot be pinned. Set
`webFetch.allowProxiedFetch` in your user settings to accept that.

### `write` or `edit` says the file was not read or changed

Read the file again, then retry. `write` needs a full read of an existing file. `edit` needs a
read whose content still matches the file on disk.

### A background command shows `interrupted`

Apex Code exited while the command was running. The command may still be running in the
operating system, so check it yourself. Apex Code does not report it as completed.

### Usage or cost stops recording after a downgrade

Version 0.7.0 moves `state.sqlite` to schema version 5. Earlier versions report the database as
newer than they support and stop recording usage and cost. Upgrade again to resume recording. A
downgrade does not delete any data.

## Developing Apex Code

Contributor setup:

```bash
git clone https://github.com/Fchery87/apex-code.git
cd apex-code
npm install
npm run build
npm run check
npm test
```

The repository's normal loop is test-first: write a failing public-boundary test, make
the smallest implementation that passes it, run the focused suite, then broaden
verification. The root checks include formatting, documentation lifecycle, frozen
package checks, import validation, lockfile/shrinkwrap checks, typechecking, and browser
smoke validation.

The repository contains forked Apex-owned packages and consumed frozen packages. Do not
patch `packages/ai`, `packages/tui`, `packages/client`, `packages/protocol`,
`packages/server`, or `packages/telemetry`; changes there belong upstream. Do not read or
copy from `c-code`. See [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md)
before opening a change.

## Project documentation

| Document | What it answers |
| --- | --- |
| [`docs/user-guide.md`](docs/user-guide.md) | Short install and first-run guide |
| [`docs/roadmap.md`](docs/roadmap.md) | What has landed, phase by phase, and the exit evidence |
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | Ownership boundaries and architecture layers |
| [`CONTEXT.md`](CONTEXT.md) | Project glossary and relationship map |
| [`docs/adr/`](docs/adr/) | Settled architectural decisions |
| [`docs/specs/`](docs/specs/) | Design specifications written before changes |
| [`packages/coding-agent/docs/providers.md`](packages/coding-agent/docs/providers.md) | Provider setup, OAuth, API keys, and model catalogs |
| [`packages/coding-agent/docs/extensions.md`](packages/coding-agent/docs/extensions.md) | Extension API and examples |
| [`packages/coding-agent/docs/environment-variables.md`](packages/coding-agent/docs/environment-variables.md) | Runtime controls and compatibility aliases |
| [`SECURITY.md`](SECURITY.md) | Security boundary and vulnerability reporting |
| [`docs/support.md`](docs/support.md) | Maintainer, response targets, and supported-version line |
| [`docs/release-integrity-runbook.md`](docs/release-integrity-runbook.md) | Recovery steps for a compromised or incorrect published release |
| [`docs/release-governance-checklist.md`](docs/release-governance-checklist.md) | Repository settings a maintainer must verify for release integrity |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contribution workflow and source hygiene |

## License

Apex Code is MIT licensed. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) for license
text and third-party attribution.
