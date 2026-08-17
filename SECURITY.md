# Security Policy

> **Pre-alpha.** The permission gate and OS-level sandbox described below landed in
> Phase 2 and are enforced today, on Linux and macOS. "Pre-alpha" describes the
> project's overall maturity and release process, not an unenforced security
> boundary — see [`docs/roadmap.md`](docs/roadmap.md) for what's landed by phase.

## Maintainer and support policy

Apex Code is currently maintained by one person, **Frantz Chery**, who owns security triage,
release authorization, and disclosure coordination. Response targets are best-effort, not a
staffed-team SLA — see [`docs/support.md`](docs/support.md) for the concrete targets,
supported-version line, and succession policy, and
[ADR 0014](docs/adr/0014-sole-maintainer-production-operations.md) for the full decision.

## Reporting a vulnerability

Report privately through [GitHub private vulnerability reporting](https://github.com/Fchery87/apex-code/security/advisories/new).
Do not open a public issue.
- Include what you did, what happened, what you expected, and the version or commit.
- Expect an acknowledgement within 5 business days (best-effort — see
  [`docs/support.md`](docs/support.md)). We will tell you whether it is in scope, and
  coordinate disclosure timing with you if it is.

## Compromised or incorrect published release

npm versions are immutable, so a bad release is deprecated and superseded, never edited in
place. See [`docs/release-integrity-runbook.md`](docs/release-integrity-runbook.md) for the
exact recovery sequence.

## What Apex Code is, security-wise

Apex Code is a local coding agent. It runs with the permissions of the user account that
starts it, executes shell commands, and reads and writes files. Extensions are
TypeScript modules that run with the same permissions as the process.

Being clear about the boundary matters more than sounding secure:

**In scope.** A bypass of the permission system that lets a tool run without a
decision. A sandbox escape that grants access the configured policy denies. A
delegated agent obtaining a capability its parent lacks. Credential leakage — keys
written to disk in cleartext, sent to an unintended host, or exposed in logs, session
files, or crash output. Privilege-boundary bugs that give access the local user did
not already have.

**Out of scope.** Prompt injection from repository files, documentation, comments,
build output, or model responses. This is expected local-agent risk and cannot be
reliably prevented by a harness; the mitigation is the permission system and the
sandbox, not input filtering. Also out of scope: the behavior of extensions or
skills you chose to install, and the fact that the agent can modify files you gave
it access to.

**Not a security boundary.** Project trust controls whether project-local settings
and extensions are *loaded*. It is an input guard, not a sandbox, and it constrains
nothing once a turn is running.

## Running untrusted work

For untrusted repositories, unattended automation, or generated code you do not
intend to review closely, run Apex Code inside a container, VM, or micro-VM with only the
files and credentials the task requires. Mount workspaces read-only where you can,
restrict network access when the task does not need it, and use short-lived
credentials. Review diffs before copying results back to trusted systems.

The Phase 2 sandbox reduces blast radius; it does not replace OS- or
virtualization-level isolation.

## Credentials

Apex Code never writes API keys to a config file it manages. Keys come from the credential
store or the environment. If you find a build that violates this, treat it as a
vulnerability and report it under this policy.
