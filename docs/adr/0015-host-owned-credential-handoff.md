# ADR 0015 — Host-owned credentials with an explicit sandbox read-only handoff

**Status:** Accepted · **Date:** 2026-08-16

## Decision

Canonical provider credentials remain host-owned in the configured Apex Code credential
store (`auth.json`) or provider environment variables. A sandboxed session receives only an
explicit read-only credential projection; it does not receive the host home directory,
ambient environment, or a writable mount containing host credentials. Session, model-cache,
settings, and temporary state remain child-owned under the workspace sandbox state until a
separate canonical session-persistence design is implemented.

The supervisor constructs a sanitized child environment and passes an explicit auth-path
handle when a credential file exists. Credential bytes are never copied into project files,
sessions, evidence, logs, or release artifacts. If the read-only projection cannot be
constructed, the session fails closed rather than silently falling back to a writable copy
or ambient host path. Provider environment credentials remain an explicit user choice and
are limited to the provider variables required by the selected runtime in a later provider-
aware handoff; the supervisor must not forward arbitrary ambient environment values.

## Consequences

- `/login` can continue to own credentials globally while a normal sandboxed turn reads them.
- The child cannot update credentials; credential changes remain an explicit host operation.
- Sessions created by sandboxed runs currently remain in sandbox state. This is deliberate until
  canonical host-session persistence is specified and tested, not an implicit export promise.
- Windows retains portability behavior but has no supported OS sandbox handoff under ADR 0005.
- The handoff must be represented in the launch contract so platform adapters cannot forget it.

## Rejected alternatives

**Copy `auth.json` into `.apex-code/sandbox-agent`.** Rejected because it persists secret
bytes inside the repository workspace and makes cleanup/disclosure dependent on best effort.

**Mount the complete host agent directory.** Rejected because it exposes unrelated sessions,
settings, caches, and tools and allows accidental disclosure across the sandbox boundary.

**Pass all of `process.env`.** Rejected because ambient variables can contain credentials,
proxy authority, or host-specific paths unrelated to the requested provider.

## Amendment (2026-08-22): a constrained supervisor-mediated write channel

"The child cannot update credentials" is amended: a sandboxed child can now *request* a
credential write through a supervisor-owned unix socket, specified in
`docs/specs/2026-08-22-supervisor-mediated-credential-writes.md` and implemented in
`core/sandbox/rpc/`. Everything else this ADR settles is unchanged, and the read-only
mount stays exactly as decided -- the channel is the one exception to it, not a loosening.

What keeps the amendment inside this ADR's posture:

- Only literal secrets pass. Values `resolveConfigValue` would treat as `!command` or
  `$VAR`/`${VAR}` references are refused before anything reaches the host file, so the
  channel cannot arrange host-side command execution.
- Reads are untouched on both sides of the boundary; the child keeps reading the
  read-only projection.
- Every accepted write and every refusal is audited in the supervisor's violation tail.
- On an enforcing backend, the host creates a missing canonical credential file as `0600`
  before launch, then carries the read-only projection and channel on the launch contract.
- The supervisor holds the host credential lock across the child's `modify` callback, so
  OAuth refresh and login retain `CredentialStore`'s cross-process serialization contract.
- The socket lives in a supervisor-owned `0700` directory, validates and byte-bounds every
  protocol frame, redacts credential values from refusals, and closes active clients during
  teardown.

## Amendment (2026-08-28): git credentials, a second class served by a channel not a mount

This ADR's read-only projection does not generalise to git credentials, and the reason is
shape rather than policy. A provider credential is one file with a stable location, so
mounting it read-only is possible. A git credential is whatever the host's configured
helper answers for a given host — `gh`, libsecret, the macOS keychain, a plain file — and
there is no single artefact to project. Reimplementing that resolution inside the child
would be a second copy of git's own, quietly diverging from the host's actual setup.

So the credential stays on the host and never enters the sandbox at all. The child runs a
helper that speaks git's ordinary `get` protocol and relays one question over a
supervisor-owned socket; the supervisor answers it by running `git credential fill` in its
own environment, where the real home is still visible. What crosses the boundary is the
answer to one question about one host, not a store, not a file, and not an environment
variable.

Two gates, and the ordering matters.

**The host must be reachable by this session.** git only asks for a credential after a
server challenged it, so in the ordinary flow the host was already permitted at the
network layer. A request for a host the session cannot open a connection to is therefore
not git doing its job, and answering it would make this channel more useful to something
hunting for a token than to git. Reachability is asked of the network proxy itself rather
than kept as a second copy of the allowlist, because a host approved at runtime under
ADR 0005's escalation amendment must count, and a duplicated list would not know.

**The human must release it**, per ADR 0023, for the same reason escalation is
supervisor-owned: this socket has no peer authentication, and every descendant in the
child's namespace can reach it. A release covers one host for the session, is never
persisted, and is never widened to a second host, so approving a push does not also
release a token to whatever the session contacts later. Without a releaser the channel
refuses outright, so a headless session hands out nothing.

Only `get` is served. `store` and `erase` are answered as handled and do nothing, which
keeps this ADR's original rule that credential mutation is an explicit host operation; a
channel that let the child rewrite the host's store would be a way out of the boundary
rather than a way to work inside it. Every grant and every refusal is recorded in the
supervisor's violation tail, by host, with no credential value in it.

This amendment does not change the provider credential projection, which stays exactly as
this ADR decided.
