# ADR 0031 — SDK sandbox contract

**Status:** Accepted · **Date:** 2026-09-06

The SDK cannot infer whether its host process is contained. A caller may run it
inside the Apex supervisor, inside another sandbox, or directly on the host. The
factory therefore exposes that fact as an explicit contract instead of implying
that ordinary SDK use has an OS boundary.

## Decision

`createAgentSession()` accepts `sandbox: "required" | "external" | "none"`.

* `"required"` means the caller requires Apex's enforced child boundary. Session
  creation fails unless the supervisor's private enforcement marker is present.
* `"external"` means another system owns containment. Apex creates the session
  but reports that it cannot verify the external boundary.
* `"none"` means no OS containment is asserted. This is the default and is
  reported in the returned diagnostic.

Delegated children inherit the parent's contract. A child cannot select a weaker
contract, create a supervisor, or turn an external assertion into proof of
containment. The marker is set only in an enforced child launch environment and
is not accepted from project configuration as authority.

The result includes the selected `sandboxContract` and a `sandboxDiagnostic`
when the SDK cannot claim Apex containment. These fields make the contract
visible to embedding applications without pretending to inspect the host.

## Consequences

An SDK caller that needs Apex's Linux or macOS boundary must run the SDK inside
the CLI supervisor and pass `"required"`. A caller already using a container,
VM, or another process boundary may pass `"external"`, but remains responsible
for proving that boundary to its own users.

The default preserves existing SDK construction behavior. It does not promise
filesystem, network, credential, or process containment. A permission gate is
also optional, so an embedding without one performs no authorization by design.

Windows has no Apex OS backend. A Windows caller cannot satisfy `"required"`.
Native platform guarantees remain those recorded in ADR 0005.

## Rejected alternative

Inferring containment from the current platform, cwd, environment, or the
presence of a supervisor-shaped directory was rejected. None of those values
proves who owns the process boundary, and project-controlled state must not
become security authority.
