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
