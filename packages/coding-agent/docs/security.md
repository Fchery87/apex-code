# Security

Apex Code is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

See also [`SECURITY.md`](https://github.com/Fchery87/apex-code/blob/main/SECURITY.md) at the repository root for the reporting process, maintainer ownership, and what is in and out of scope; this page covers the underlying project-trust and sandboxing mechanics in more detail.

## Project Trust

Project trust controls whether Apex Code loads project-local settings, resources, packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

Apex Code considers a project to have resources that require trust when it finds any of these from the current working directory:

- `.apex-code/settings.json`
- `.apex-code/extensions`, `.apex-code/skills`, `.apex-code/prompts`, or `.apex-code/themes`
- `.apex-code/SYSTEM.md` or `.apex-code/APPEND_SYSTEM.md`
- project `.agents/skills` in the current directory or an ancestor directory

A bare `.pi` directory does not count as a project resource that requires trust — `.apex-code` is the canonical project directory name (see [Environment compatibility](../README.md#environment-compatibility)).

When an interactive session starts in a project with resources that require trust and no saved decision for the current directory or a parent directory, Apex Code follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.apex-code/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

Trusting a project allows Apex Code to load project resources that require trust, including:

- `.apex-code/settings.json`
- `.apex-code` resources such as extensions, skills, prompt templates, themes, and system prompt files
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources. Context files such as `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` are loaded regardless of project trust unless context loading is disabled. Before trust is resolved, Apex Code only loads context files, user/global extensions, and CLI `-e` extensions. User/global and CLI extensions can handle the `project_trust` event; the first extension that returns a yes/no decision owns the decision.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## OS Sandbox and Permissions

Unlike upstream Pi, Apex Code adds a permission gate in front of every tool call and an OS-level sandbox on Linux and macOS (Bubblewrap and Seatbelt respectively) — see [ADR 0005](https://github.com/Fchery87/apex-code/blob/main/docs/adr/0005-sandbox-boundary-guarantees.md) for exactly what that boundary does and does not guarantee, and the root [`SECURITY.md`](https://github.com/Fchery87/apex-code/blob/main/SECURITY.md) for what counts as a reportable bypass. Windows has no supported sandbox backend. Outside of the permission gate and OS sandbox, built-in tools, extensions, package installs, shell commands, language servers, and other developer tools still run with the permissions of the Apex Code process.

Project trust is only an input-loading guard, layered underneath the permission gate and sandbox. It prevents a repository from silently changing Apex Code's settings or extensions before you approve it. It does not make untrusted code, untrusted prompts, or untrusted model output safe by itself. Prompt injection from repository files, comments, documentation, context files, or build output is expected local-agent risk and cannot be reliably prevented by Apex Code.

## Running Untrusted or Unmonitored Work

For untrusted repositories, generated code you do not intend to monitor closely, or unattended automation, run Apex Code in a contained environment in addition to its own sandbox. Use a container, VM, micro-VM, remote sandbox, or policy-controlled sandbox with only the files and credentials required for the task.

Common patterns are documented in [Containerization](containerization.md):

- run the whole Apex Code process inside a container/sandbox
- run host Apex Code while routing built-in tool execution into a Gondolin micro-VM
- mount only the workspace paths the agent should access
- avoid mounting host `~/.apex-code/agent` unless the container should access host sessions, settings, and credentials
- pass the minimum required API keys or use short-lived credentials
- restrict network access when the task does not need it
- review diffs and outputs before copying results back to trusted systems

If you bind-mount a host workspace read/write, writes from inside the container or VM can still modify host files. Use read-only mounts or copy files into and out of the sandbox when you need stronger protection from unintended writes.

## Reporting Security Issues

To report a security issue, follow Apex Code's own [Security Policy](https://github.com/Fchery87/apex-code/blob/main/SECURITY.md) — private disclosure via [GitHub private vulnerability reporting](https://github.com/Fchery87/apex-code/security/advisories/new). Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real bypass of the permission gate or OS sandbox, or shows how Apex Code grants access that the local user did not already have. See `SECURITY.md`'s "In scope"/"Out of scope" sections for the current, authoritative boundary.
