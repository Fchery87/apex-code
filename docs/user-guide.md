# User guide

Apex Code is pre-alpha. This page covers install, first run, and where to go next —
not a full reference. For what's built and what's still planned, see
[`docs/roadmap.md`](roadmap.md).

## Install

```bash
npm install --global apex-code@next
apex-code --version
```

`@next` is the current prerelease channel — this project has not promoted a
`latest` release yet. Requires Node.js ≥ 22.19.0.

**Supported platforms:** Linux and macOS. Windows is not supported (see
[ADR 0005](adr/0005-sandbox-boundary-guarantees.md)).

## First run

```bash
apex-code
```

On first run you'll see a one-step setup dialog to pick a light or dark theme.
Confirm or press Escape to skip it — nothing else is asked, and nothing is sent
anywhere as part of this step.

You'll need a model provider configured before you can start a session. Inside
Apex Code, run:

```
/login <provider>
```

to configure credentials interactively (API key or OAuth, depending on the
provider). `apex-code auth check --provider <provider>` verifies a provider's
credentials from outside a session. Run `apex-code --help` for the full flag
reference, including `--provider`/`--model` to pick a default without editing
config files.

## Core concepts

**Permissions.** Every tool call (reading/writing files, running shell commands,
network access) goes through a permission gate before it runs. `--permission-mode`
controls the default posture (`default` asks for anything not already allowed;
`plan` blocks mutating operations entirely; `acceptEdits`, `bypassPermissions`, and
`dontAsk` loosen it in different ways). Non-interactive sessions (`--print`, `--mode
json`, `--mode rpc`) require an explicit `--permission-mode`.

**Sandbox.** On Linux and macOS, tool execution runs inside an OS-level sandbox
restricting filesystem writes and network access to what the permission layer has
allowed — not just an application-level check. See
[`SECURITY.md`](../SECURITY.md) for exactly what this does and does not guarantee;
it is not a substitute for container/VM isolation when running fully untrusted work.

**Sessions.** Conversations are stored as JSONL files with a branching tree
structure — you can fork from any earlier point (`/fork`, `/tree`) rather than only
ever continuing linearly. `--continue`/`--resume` pick up a previous session;
`--session`/`--session-id` target a specific one.

**Cost and usage.** `apex-code cost` reports recorded spend grouped by model,
session, or role. `/session` shows the current session's token/cost breakdown
during a run.

## Where to go next

| Topic | Where |
| --- | --- |
| What's built vs. planned, by phase | [`docs/roadmap.md`](roadmap.md) |
| Security posture and reporting a vulnerability | [`SECURITY.md`](../SECURITY.md) |
| Architecture: what's forked, consumed, extended | [`docs/architecture/overview.md`](architecture/overview.md) |
| Settled design decisions | [`docs/adr/`](adr/) |
| Contributing | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Third-party licenses | [`NOTICE`](../NOTICE) |
