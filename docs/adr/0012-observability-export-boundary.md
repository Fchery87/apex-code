# ADR 0012 — User-directed observability export is not project telemetry

**Status:** Accepted · **Date:** 2026-08-15

## Decision

Apex Code treats **two categorically different kinds of outbound data** as separate
systems that never share a switch, a settings key, a code path, or a consent
decision.

| | Destination | Default | Consent | Governed by |
| --- | --- | --- | --- | --- |
| **Observability export** | An endpoint **the user names** — their own collector | Off; inert unless an endpoint is configured | Configuring the endpoint *is* the consent | This ADR |
| **Project telemetry** | Infrastructure **the project controls** | Out of scope here | Opt-in, per the roadmap's Phase 9 commitment | ADR 0009 |

The observability export emits OpenTelemetry **traces** over OTLP/HTTP with JSON
encoding, through the process-global `fetch` that `http-dispatcher.ts` binds to a
proxy-aware undici dispatcher. No OpenTelemetry SDK is taken as a dependency.

Span attributes are an **allowlist**, fixed in code and asserted by test. Permitted:
provider, model, role, outcome, failure kind, ttft, generation duration, the four
token counts, cost, the opaque `credentialIdentity` label, and tool **names**.
Forbidden, and never added later without amending this ADR: prompt or message
content, tool arguments, tool results, file paths, workspace paths, environment
values, and anything derived from a credential beyond the opaque identity label.

A user's own collector endpoint does not widen the allowlist. "It's their data going
to their server" is not a reason to include prompt content, because a collector is
routinely a shared, multi-tenant, longer-retention system that the person typing the
prompt may not control.

## Why this shape

Both things are called "telemetry" in ordinary speech, and that shared word is the
whole hazard. A single `telemetry.enabled` key covering both would mean a user
enabling trace export to their local Jaeger had silently also consented to sending
usage data to the project — or, in the other direction, that a user disabling the
project ping lost their own production monitoring. Neither is defensible, and the
error is invisible at the point where it happens, which is what makes it worth an
ADR rather than a comment.

The allowlist is a positive list rather than a redaction pass because the failure
directions are asymmetric. A denylist that has not been updated for a newly added
field **emits** it; an allowlist that has not been updated **drops** it. Dropping a
field produces a missing chart. Emitting one produces a prompt in someone's log
aggregator, which cannot be recalled.

Traces rather than metrics: the OTLP metrics data model carries aggregation
temporality and several histogram encodings whose correct hand-rolling is most of
the cost, while collectors already derive rate and latency metrics from spans as a
standard operation. Emitting both would mean building the harder payload to produce
data the easier one already implies.

Global `fetch` rather than a direct undici import: `http-dispatcher.ts` already
installs an `EnvHttpProxyAgent` with the user's proxy and idle-timeout settings. A
second HTTP client inside the exporter would bypass `HTTP_PROXY` — an egress path
that ignores a user's proxy configuration is a defect in exactly the component that
must be most conservative about egress.

## Inherited state this ADR does not resolve

`settings-manager.ts` returns `enableInstallTelemetry ?? true` — an anonymous
version/update ping inherited from upstream Pi, live in interactive mode, **on by
default**. That sits against the roadmap's Phase 9 commitment to opt-in-only
telemetry.

It is recorded here so the contradiction is not invisible, and deliberately **not**
changed by this ADR. It is project-directed telemetry, so it belongs to ADR 0009;
and it is upstream behaviour, so changing it carries a divergence cost under
ADR 0003 that Phase 9 should weigh with the rest of that decision. This ADR's
obligation is narrower and absolute: whatever Phase 9 decides, the two systems do
not merge into one switch.

## Consequences

- Observability export is inert on a fresh install. A test asserts zero outbound
  requests attributable to observability across a full turn when no endpoint is
  configured.
- Adding a field to `UsagePerformanceSample` does **not** add it to exported spans.
  That is intentional friction: a second, explicit edit is required, and it is the
  edit a reviewer can see.
- Apex Code owns OTLP wire-format conformance for the subset it emits, and will not
  gain new signals for free as the OTel spec grows. Accepted in exchange for zero
  added dependencies in a distributed CLI.
- Trace export cannot be used to satisfy any future project-telemetry need. If the
  project wants usage data, that is ADR 0009's problem and requires its own consent.

## Rejected alternatives

**One `telemetry` settings namespace covering both.** Rejected: it is precisely the
conflation this ADR exists to prevent, and the resulting mis-consent is silent.

**The official OpenTelemetry SDK.** Rejected: ~40–60 transitive packages and a new
upstream churn surface in a CLI that pins 21 direct dependencies, to send a POST
whose wire format is public. Revisit if we ever need auto-instrumentation or the
metrics signal.

**A denylist/redaction pass over span attributes.** Rejected on the asymmetry above:
it fails open, and the failure is unrecallable.

**Export on by default to a local collector.** Rejected: "nothing listens on that
port anyway" is an assumption about someone else's machine, and a default-on egress
path in an observability feature is how trust is lost once and not regained.
