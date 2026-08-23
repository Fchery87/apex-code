# Apex Code

A provider-agnostic agentic coding harness for working with real repositories from the
terminal. Apex Code can inspect a codebase, explain it, make changes, run commands,
coordinate bounded subagents, preserve a resumable session, and record evidence about
what actually happened.

Apex Code is a fork of Pi's coding-agent and agent-core layers, with a deliberate
boundary around the upstream provider and terminal foundations. It keeps the breadth of
Pi's provider layer while adding a safety floor, a larger tool surface, durable state,
verification evidence, and operational visibility.

> **Status: pre-alpha — Phases 0 through 12 have landed.** The product is usable and
> actively developed, but APIs, configuration, and release practices may still change.
> The [roadmap](docs/roadmap.md) records what is implemented and how each phase was
> verified.

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
- Linux and macOS have the supported OS-sandbox backends. Windows is a required
  portability target and the CLI works there, but Windows sandbox enforcement remains
  unsupported under [ADR 0005](docs/adr/0005-sandbox-boundary-guarantees.md).

### Install the prerelease from npm

Apex Code currently uses npm's `next` prerelease channel rather than the stable
`latest` tag. It installs the same way with npm, pnpm, Yarn, or Bun — all resolve it
from the same npm registry:

```bash
npm install --global apex-code@next      # npm
pnpm add --global apex-code@next         # pnpm
yarn global add apex-code@next           # Yarn
bun add --global apex-code@next          # Bun

apex-code --version
```

The command installs the `apex-code` executable globally. Apex Code does not operate a
shell installer or a separate standalone-binary update channel. To update an existing
installation, use the same npm channel:

```bash
npm install --global apex-code@next
# or from an existing installation:
apex-code update --self
```

If your system does not permit global npm writes, use a Node version manager, configure
npm's global prefix, or run Apex Code through a project-local installation. Do not use
`sudo` unless you understand and intentionally accept the permissions and ownership
implications for your Node installation.

### Install from this repository

This path is for contributors and people testing unreleased changes:

```bash
git clone https://github.com/Fchery87/apex-code.git
cd apex-code
npm install
npm run build
npx tsx packages/coding-agent/src/cli.ts --version
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

## How Apex Code works

Apex Code is an agent loop surrounded by policy, state, and verification layers. A
normal turn follows this shape:

1. **Build context.** Apex Code combines the system prompt, session history, project
   context files such as `AGENTS.md`, the current request, enabled tools, and relevant
   extension state.
2. **Select a model.** The configured provider/model and reasoning level determine which
   upstream `pi-ai` adapter receives the request.
3. **Ask for the next action.** The model can answer directly or request a tool call.
4. **Check policy.** The tool's declared contract is evaluated against permission rules,
   project trust, and the active permission mode before execution.
5. **Run the tool.** File, search, shell, network, question, planning, and delegation
   tools perform the requested operation inside the applicable sandbox boundary.
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
- `plan` blocks mutating operations while you investigate or design a change.
- `acceptEdits` reduces prompts for file edits while retaining other checks.
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

### OS sandbox

On Linux and macOS, every command that can start an agent session runs inside an OS-level
sandbox, beneath the application-level permission decision. Commands that only inspect or
maintain host configuration — `auth`, `config`, `install`, `--version`, `--help` — stay
outside it. Windows remains a portability target, not a sandbox-enforcement target.

**Filesystem.** The workspace is the only writable location. The invoking account's home
directory is hidden, so a session cannot read `~/.ssh`, `~/.aws`, or shell history, and its
own state lives under `<workspace>/.apex-code/`. Provider credentials are projected in
read-only from `auth.json`. `fd` and `ripgrep` are resolved on the host and projected in
read-only, so search works without the session needing to download anything.

**Network.** All egress passes through an allowlist proxy; the session has no direct route
out. The built-in model-provider hosts and the npm update check are permitted by default,
so a new install can reach its provider without configuration. Add anything else in global
`settings.json`:

```json
{
  "network": {
    "allowedHosts": ["registry.internal.example", "proxy.internal.example:8443"]
  }
}
```

A bare hostname matches any port; `hostname:port` pins one. Adding
`"allowDefaultHosts": false` to that block denies everything the list does not name. A
refused request reports the host and the setting that would permit it, and the refusals
for a session are summarised when it exits.

Providers whose endpoint depends on account or environment configuration — Amazon Bedrock,
Azure OpenAI, Cloudflare, Google Vertex — are not in the default set and need an explicit
entry. So does a mid-session `/model` switch to one of them, because the allowlist is fixed
when the session starts.

**`/share`.** Gist upload runs the GitHub CLI, whose credentials live in the host home that
the sandbox hides. Run `/export <file>` inside the session, then
`gh gist create --public=false <file>` outside it.

For untrusted repositories or unattended generated code, use a container, VM, or micro-VM
with only the files and credentials the task requires. Read [`SECURITY.md`](SECURITY.md)
before relying on Apex Code for higher-risk work.

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

Project-local resources live under `.apex-code/`, including project settings,
extensions, skills, prompts, and other repository-specific configuration. Keep local
Apex state out of source control unless you intentionally maintain a sanitized,
reviewable project configuration. Never commit `auth.json`, session files containing
sensitive content, or generated evidence that includes secrets.

Sessions are JSONL files whose entries form a tree through parent and entry IDs. This
means you can branch in place instead of creating a new transcript for every experiment:
`/tree` navigates branches, `/fork` creates a new branch, and `--continue` or `--resume`
returns to prior work.

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

### Share a session deliberately

`/share` first asks for confirmation, then exports the complete session HTML and uses
your authenticated GitHub CLI to create a **secret Gist**. Secret means unlisted, not
private or access-controlled; anyone with the URL can read it. The export can contain
prompts, tool calls and results, paths, and file content. Use `/export` to inspect a
local copy first. By default Apex Code returns the GitHub Gist URL; configure
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

## Network and privacy

Apex Code sends no project-directed usage telemetry. At startup it may query npm for the
`apex-code@next` version; disable that request with:

```bash
APEX_CODE_SKIP_VERSION_CHECK=1 apex-code
```

Model requests go to the provider you select. Optional OTLP traces are sent only to an
endpoint you explicitly configure, using an allowlist that excludes prompts, messages,
tool arguments, tool results, file paths, workspace paths, and environment values.

The default model catalog is local. The `/share` viewer is not a default hosted service;
`APEX_CODE_SHARE_VIEWER_URL` is an explicit opt-in endpoint. The npm registry, your model
provider, GitHub when you explicitly publish an export as a gist, and any configured
integration can still receive data required for that operation. Read the destination's
policies and review sensitive content before sending it.

Inside the OS sandbox these requests are additionally constrained by the network allowlist
described under [OS sandbox](#os-sandbox): a host that is not permitted is refused before
the request leaves the machine.

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
credentials, and review outputs before moving them into a trusted environment. The
Apex Code sandbox reduces blast radius on supported platforms but is not a replacement
for virtualization.

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
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contribution workflow and source hygiene |

## License

Apex Code is MIT licensed. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) for license
text and third-party attribution.
