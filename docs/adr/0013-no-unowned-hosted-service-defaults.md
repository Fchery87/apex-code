# ADR 0013 — No unowned hosted-service defaults

**Status:** Accepted · **Date:** 2026-08-16

## Decision

Apex Code has **no default functional dependency on a hosted service the project does
not operate**. A fresh installation uses the model catalog bundled with `pi-ai`; it does
not refresh that catalog from `pi.dev`. `/share` creates a secret GitHub Gist only at the
user's command and returns GitHub's canonical Gist URL; it does not advertise a
third-party preview unless the user explicitly configures one.

Two user-directed integrations remain supported:

- `APEX_CODE_MODEL_CATALOG_URL` names a compatible remote catalog service. The temporary
  `PI_MODEL_CATALOG_URL` alias follows Phase 10's compatibility window. The SDK's
  existing `catalogBaseUrl` option is the programmatic equivalent. With neither value,
  the remote overlay is absent rather than pointed at a project-selected host.
- `APEX_CODE_SHARE_VIEWER_URL` names a viewer that receives a secret Gist identifier in
  its URL. The bounded `PI_SHARE_VIEWER_URL` compatibility alias remains through the
  Phase 10 window, but there is no default URL. Before publishing, `/share` presents an
  explicit disclosure and confirmation; cancellation performs no upload.

Provider APIs selected by the user, the npm registry used for the documented update
check, user-named OTLP collectors, and the GitHub operation explicitly invoked by
`/share` are outside “hosted-service defaults.” Each has its own affirmative action or
configuration and an independently documented purpose.

## Why this shape

The remote catalog is not required for correctness: the consumed provider package
already ships generated model data, and production already falls back to it when the
Pi endpoint is unavailable. Default network refresh therefore exchanges version and
platform metadata for freshness supplied by infrastructure Apex neither controls nor
promises.

The share viewer has a sharper confidentiality consequence. GitHub calls an unlisted
Gist “secret,” not private. Its ID is sufficient to retrieve it. Opening the current
preview discloses that identifier to `pi.dev`, whose behavior, retention, and
availability Apex cannot govern. The GitHub URL is already a complete, honest result
from the explicit upload and requires no second service.

This is not a telemetry decision. ADR 0009 governs project-directed usage collection;
ADR 0012 governs export to a user-named collector. These are functional egress paths.
The relevant boundary is ownership and user direction, not whether the request is
called telemetry.

## Consequences

- Static model information can age until the next consumed `pi-ai` update. That is an
  explicit release-maintenance obligation and a safer failure mode than an unowned
  default service.
- Distributions that operate a compatible catalog can configure it without forking.
  Response validation, caching, freshness ordering, retries, and offline behavior stay
  unchanged.
- `/share` continues to require `gh` and upload the full HTML export to GitHub only after
  confirmation. Its UI must call this a secret Gist, warn that the export can contain the
  complete transcript/tool content, and show the exact Gist URL. A configured viewer is an
  additional convenience URL, never the only result.
- Removing the `pi.dev` defaults is immediate in pre-alpha. The environment-name alias
  is retained because changing a default does not cancel Phase 10's compatibility
  promise.
- Apex incurs no new server, privacy-policy, abuse, retention, or uptime obligation.

## Rejected alternatives

**Keep `pi.dev` and document it better.** Honest disclosure is necessary but does not
turn another project's infrastructure into an Apex-owned contract.

**Mirror or proxy Pi's catalog through an Apex endpoint.** Rejected: it adds an
operational service without changing the underlying data-ownership question.

**Build an Apex share viewer now.** Rejected: hosting arbitrary shared session content
requires abuse handling, a privacy policy, retention rules, and incident response. The
canonical Gist link already works.

**Remove remote catalogs and viewer integration entirely.** Rejected: explicit,
user-named endpoints are useful for organizations and downstream distributions and do
not create a silent default dependency.
