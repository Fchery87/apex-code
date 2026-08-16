# ADR 0016 — Trust-first supervisor policy inputs

**Status:** Accepted · **Date:** 2026-08-16

## Decision

Before the OS sandbox child starts, supervisor security policy may come only from the
runtime environment and explicit user/maintainer-controlled inputs. Project-local settings,
packages, extensions, skills, prompts, and other files are not eligible to configure sandbox
mounts, network allowlists, command/arguments, credential paths, or child environment before
project trust is resolved.

The current CLI therefore loads only global settings when resolving the supervisor's network
allowlist (`projectTrusted: false`); project-local `network.allowedHosts` is ignored for that
outer decision. The child may load project configuration after normal project-trust handling,
but that configuration cannot widen the already-created OS supervisor policy. With no trusted
supervisor policy, the default remains conservative and fail-closed according to ADR 0005.

## Consequences

- A malicious repository cannot widen its own pre-child network policy through
  `.apex-code/settings.json`.
- Project settings may still control ordinary in-process behavior after trust, subject to the
  existing permission and sandbox boundary.
- A future explicit CLI policy flag must be parsed and validated outside project resources and
  recorded in the launch contract before it can affect the supervisor.
- This clarifies ADR 0005's policy source precedence; it does not add Windows sandbox support
  or weaken Linux/macOS fail-closed behavior.

## Rejected alternatives

**Read merged settings before trust.** Rejected because project-controlled values would become
security authority before the project was trusted.

**Ignore all network policy, including global policy.** Rejected because users and operators
need an explicit way to configure allowed provider/catalog hosts without editing the project.
