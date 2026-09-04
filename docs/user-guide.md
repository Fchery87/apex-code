# User guide

Apex Code is pre-alpha. This page covers install, first run, and where to go next —
not a full reference. For what's built and what's still planned, see
[`docs/roadmap.md`](roadmap.md).

## Install

```bash
npm install --global apex-code
apex-code --version
```

This project has published no stable version yet, so `latest` names the newest
verified prerelease and a plain install resolves it (ADR 0026). Requires Node.js
≥ 22.19.0.

Or install the standalone binary without Node.js. The POSIX installer supports macOS,
Linux, and **Git Bash on Windows**:

```bash
curl -fsSL https://raw.githubusercontent.com/Fchery87/apex-code/main/install.sh | bash
```

For PowerShell, including PowerShell in Windows Terminal:

```powershell
irm https://raw.githubusercontent.com/Fchery87/apex-code/main/install.ps1 | iex
```

Each installer verifies the downloaded archive against the matching GitHub Release's
SHA-256 manifest before extraction, adds its per-user command directory to `PATH`, and
prints the one command to run after you open a new terminal session. The full install
instructions, including version pinning, are in the [README](../README.md#install-the-standalone-binary-from-github-releases).

**Supported platforms:** Linux and macOS have the supported OS sandbox backends. Windows
is a supported portability/install target, but sandbox enforcement remains unsupported
under [ADR 0005](adr/0005-sandbox-boundary-guarantees.md).

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
json`, `--mode rpc`) require an explicit `--permission-mode`. In an interactive session,
`/settings` > **Permission mode** changes it without restarting; the choice is saved to
`~/.apex-code/agent/permissions.json` and applies to the next tool call.

**Sandbox.** On Linux and macOS, the whole session runs inside an OS-level sandbox
restricting filesystem writes to the workspace and network access to an allowlist — not
just an application-level check. It is a **separate layer from the permission gate**, and
the one you cannot change from inside a session: its mounts and its allowlist are fixed by
the supervisor before the session's process starts, so no permission mode, including
`bypassPermissions`, widens either. A tool call the gate waves through is still refused by
the boundary if it writes outside the workspace or reaches an unlisted host. See
[`SECURITY.md`](../SECURITY.md) for exactly what this does and does not guarantee;
it is not a substitute for container/VM isolation when running fully untrusted work.

**Sessions.** Conversations are stored as JSONL files with a branching tree
structure — you can fork from any earlier point (`/fork`, `/tree`) rather than only
ever continuing linearly. `--continue`/`--resume` pick up a previous session;
`--session`/`--session-id` target a specific one.

**Checkpoints.** Off by default. Setting `"checkpoints": { "enabled": true }` in
`~/.apex-code/agent/settings.json` makes Apex Code snapshot your working tree at the start
of every turn, keyed to the same session entry `/fork` and `/tree` navigate to. Tracked
edits and untracked files are both captured; anything matched by `.gitignore` is not.

Checkpoints are scoped to the whole repository, not to your working directory. Opening a
subdirectory of a repository as your workspace still snapshots and restores every file in
that repository.

A snapshot never touches your index, working tree, `HEAD`, current branch, or stash, and
runs no git hooks. It is a commit object pinned under
`refs/apex-code/checkpoints/<sessionId>/<entryId>`, which is why it survives both `git gc`
and quitting the session. `maxPerSession` (default 50) bounds how many are kept.

A restore writes back exactly the bytes that were captured, including line endings, and is
not affected by `core.autocrlf`. If your repository declares `text` or `text=auto` in
`.gitattributes`, restored files follow that policy the same way `git checkout` does.

Inspect them with ordinary git, and remove every one with:

```bash
git for-each-ref --format='%(refname)' 'refs/apex-code/**' | xargs -r -n1 git update-ref -d
```

Capturing is all the harness does on its own. To be *offered* a restore when you `/fork`
back to an earlier entry, enable the `git-checkpoint` extension from
`examples/extensions/`. A restore puts the working tree back exactly, including removing
files created after the checkpoint, and pins the pre-restore state first so it can be
undone.

**Workspace state.** Every compaction also records what the workspace looked like: the
repository root, the current base, and up to 200 changed paths, each with a SHA-256
digest (files over 5 MiB are listed but not hashed; symlink entries hash their target
path). The session's own state directory is excluded. The observation is a child of the
compaction entry: the model sees a bounded projection, never a raw diff, and no patch
content is captured.

The first turn after a compaction — and the first turn after resuming a session whose
latest observation never got one — compares fresh state against the stored observation
and records the outcome: `same`, `drifted` (with the changed paths), `unavailable` (the
workspace cannot be observed right now), or `inconclusive` (the stored record is too
partial to judge). The historical observation is never rewritten. Outside a Git
repository nothing is recorded and nothing fails.

**Navigation choices.** `/tree` and `/fork` move only the conversation; your files are
never touched unless a workspace policy says otherwise. The session API accepts an
explicit policy: `keep` (the default — conversation only), `restore` (put the workspace
back to the checkpoint pinned at the target entry; a pre-restore checkpoint is pinned
first so the restore itself can be undone), `fail-if-drifted` (refuse the whole
navigation when files moved since the checkpoint), and `cancel` (the same refusal, for
interactive flows). A missing checkpoint leaves your files unchanged and says so.

**Cost and usage.** `apex-code cost` reports recorded spend grouped by model,
session, or role. `/session` shows the current session's token/cost breakdown
during a run.

### Configured verification and formatting

**Verification.** A project or user `settings.json` can declare verification
policies — commands the agent runs to check its work. Each policy has an id, an
executable, an argv, and numeric bounds (timeout, output bytes, output lines);
commands never run through a shell. Run one on demand with
`requestVerification`, or set `policies.boundary` to `"post-turn"` to run the
first configured policy after every completed turn. The session reports one of
five states: `verified`, `failed`, `unavailable` (nothing configured), and —
when the command was cancelled or timed out — the record says so instead of
pretending. If you choose to keep working without verifying, the session says
`continued-unverified` rather than silently implying a clean bill. A result
retires the moment the workspace changes: a "verified" from three edits ago is
not a "verified" now.

**Formatting.** Formatter policies work the same way (`runConfiguredFormatter`).
A formatter may only write inside its `declaredPaths` (which must stay inside
the policy's `pathScope`), and the session reports exactly what changed:
declared mutations, unexpected writes outside the declared scope, and any write
that escaped the workspace through a symlink. Nothing is reverted
automatically — the report is the evidence you act on.

A `settings.json` declares them like this:

```json
{
  "policies": {
    "schemaVersion": 1,
    "verification": [
      {
        "id": "typecheck",
        "executable": "npx",
        "argv": ["tsgo", "--noEmit"],
        "cwd": "workspace",
        "timeoutMs": 120000,
        "maxOutputBytes": 262144,
        "maxOutputLines": 2000,
        "permission": "allow"
      }
    ],
    "formatter": [
      {
        "id": "format",
        "executable": "npx",
        "argv": ["biome", "format", "--write", "."],
        "cwd": "workspace",
        "declaredPaths": ["src/**/*.ts"]
      }
    ]
  }
}
```

Policies load per source (user settings, project settings) and a trusted
project's policy replaces a user policy with the same id (ADR 0028). Any
invalid entry drops that entire source rather than running a half-validated
command. Evidence (policy id, argv, cwd, status, duration, exit code, artifact
reference) is bounded and never includes raw command output in the
conversation; full output goes to the session's artifact store.

## Sharing sessions

`/share` is an explicit publication action. Apex Code first asks for confirmation, then
exports the complete session HTML and uses your authenticated GitHub CLI to create a
**secret Gist**. Secret means unlisted, not private or access-controlled: anyone with the
URL can read it. The export may contain the complete transcript, prompts, tool calls and
results, paths, and file content, so use `/export` to review it locally first when needed.

By default Apex Code returns only GitHub's Gist URL. Set `APEX_CODE_SHARE_VIEWER_URL` to
a viewer you trust if you also want a convenience preview link. Bundled model catalogs
likewise require no hosted service; `APEX_CODE_MODEL_CATALOG_URL` explicitly enables a
compatible remote overlay.

## Where to go next

| Topic | Where |
| --- | --- |
| What's built vs. planned, by phase | [`docs/roadmap.md`](roadmap.md) |
| Security posture and reporting a vulnerability | [`SECURITY.md`](../SECURITY.md) |
| Architecture: what's forked, consumed, extended | [`docs/architecture/overview.md`](architecture/overview.md) |
| Settled design decisions | [`docs/adr/`](adr/) |
| Contributing | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Third-party licenses | [`NOTICE`](../NOTICE) |

## Environment compatibility

Apex-owned runtime controls use `APEX_CODE_*` names. The main controls are
`APEX_CODE_OFFLINE`, `APEX_CODE_SKIP_VERSION_CHECK`, `APEX_CODE_PACKAGE_DIR`,
`APEX_CODE_EXPERIMENTAL`, `APEX_CODE_MODEL_CATALOG_URL`, and `APEX_CODE_SHARE_VIEWER_URL`. Temporary legacy `PI_*`
aliases remain supported through the pre-1.0 line. The canonical Apex name wins when
both are set, and legacy-only use emits a deprecation diagnostic. Removal will occur
no earlier than Apex Code 1.0.0 and no earlier than 2027-02-16, with release notes.
