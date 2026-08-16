# Research: hosted-service defaults after the Apex Code fork

**Date:** 2026-08-16 · **Status:** Permanent — decision input for Phase 11 and ADR 0013

## Question

Should Apex Code continue to contact Pi-operated services by default for model-catalog
refreshes and shared-session previews, or should those services require explicit
configuration?

This investigation used the Apex Code repository at `d47de47efe949c676822c76de9a7182c115dad59`,
the live public `pi.dev/session/` page, and GitHub's official Gist and CLI documentation.
It did not inspect any unlicensed source.

## Finding 1 — the model catalog is an optional overlay, not a runtime prerequisite

`packages/coding-agent/src/core/remote-catalog-provider.ts:6-105` wraps each built-in
provider with a four-hour remote overlay. For every provider it requests
`GET https://pi.dev/api/models/providers/<provider-id>`, sending the provider identifier
in the URL, an Apex Code version/platform/runtime/architecture User-Agent, and, after a
successful response, the service's ETag. The response may replace or add complete model
records and is persisted in `models-store.json`. The code restores the static built-in
provider first, rejects remote data older than the generated catalog, retains cached
data across transient failures, and treats 404/501 as an unavailable overlay.

`packages/coding-agent/src/core/model-runtime.ts:232-243` proves that the built-in catalog
comes from the consumed `@earendil-works/pi-ai/providers/all` package and that the remote
service is only an overlay. `APEX_CODE_OFFLINE` suppresses network refresh but is broader
than this decision: it also suppresses other startup network behavior. SDK callers can
inject `catalogBaseUrl`; ordinary CLI users cannot select a catalog service independently.

A live request to `https://pi.dev/api/models/providers/anthropic` from this investigation
timed out after 45 seconds. That one observation is not an availability measurement, but
it demonstrates why a third-party overlay cannot be required for startup correctness.
The production implementation is already designed to fall back to static data.

## Finding 2 — `/share` uploads to GitHub first, then advertises a Pi viewer

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:5841-5924` exports the
complete session as HTML to a temporary file and invokes:

```text
gh gist create --public=false <session.html>
```

Only after GitHub returns a Gist URL does Apex Code extract the Gist ID and call
`getShareViewerUrl()`. `packages/coding-agent/src/config.ts:503-508` defaults that viewer
to `https://pi.dev/session/#<gist-id>`, with `APEX_CODE_SHARE_VIEWER_URL` as an override.
Thus `/share` already gives the session to GitHub at the user's explicit command. In the
observed fragment-based viewer, the initial request to `pi.dev` ordinarily omits the Gist
ID; Pi serves the viewer code and receives browser/request metadata, while that code has
the recipient browser fetch the identified Gist from GitHub. Apex cannot govern future
viewer behavior.

GitHub's official `gh gist create` manual documents `--public` as “List the gist publicly
(disabled by default),” while GitHub's REST documentation describes the resulting API
resource and file/raw URLs:

- https://cli.github.com/manual/gh_gist_create
- https://docs.github.com/en/rest/gists/gists#get-a-gist

GitHub calls non-public Gists **secret**, not private; possession of the URL or ID grants
access. Apex Code must not describe the upload as private.

The live `https://pi.dev/session/` response on 2026-08-16 contained a single inline
script. It reads the Gist ID from `location.hash`, then fetches
`https://api.github.com/gists/<id>` (and `raw_url` for truncated content) in the user's
browser. No analytics script was present in that response. This is useful behavior, but
Apex Code neither owns its availability nor its future privacy behavior.

## Finding 3 — neither dependency is project telemetry, but both are unowned egress

ADR 0009 correctly defines project telemetry as usage data sent to infrastructure the
Apex Code project controls. These endpoints are instead functional dependencies on
infrastructure operated by another project. That distinction means they do not need a
telemetry consent switch; it does **not** justify silently selecting them for users.

The two paths have different data shapes:

| Path | Trigger | Data exposed to unowned service | Local fallback |
| --- | --- | --- | --- |
| Model catalog | startup/refresh when network is allowed | provider ID, Apex version/platform/runtime/architecture User-Agent, cache validator, IP/network metadata | generated `pi-ai` catalog |
| Share viewer | user invokes `/share`, then opens/copies preview | secret Gist ID plus browser/network metadata; viewer then retrieves full Gist from GitHub | exact Gist URL already returned by `gh` |

## Options evaluated

### Keep both defaults and improve disclosure

Rejected. Disclosure would make the dependency honest but not owned. A branding,
availability, API, retention, or access-policy change can still alter Apex behavior
without an Apex release.

### Operate Apex-hosted replacements

Rejected for this phase. It adds deployment, abuse prevention, privacy policy, incident
response, retention, and uptime obligations to a pre-alpha CLI. No such infrastructure
exists today.

### Bundle static catalog data and require explicit remote endpoints

Accepted. Static catalog data is already shipped and is the existing failure fallback.
A new `APEX_CODE_MODEL_CATALOG_URL` can opt a user or distribution into a compatible
remote overlay. SDK `catalogBaseUrl` remains an explicit caller-selected equivalent.
With neither configured, no catalog request occurs.

### Keep `/share`, but return only the GitHub Gist URL by default

Accepted. `/share` is already an explicit GitHub upload performed by the user's `gh`
identity. The command should label it a **secret Gist**, return that canonical URL, and
add a preview URL only when `APEX_CODE_SHARE_VIEWER_URL` is explicitly configured. The
legacy `PI_SHARE_VIEWER_URL` remains a bounded compatibility alias under Phase 10's
published policy; the `pi.dev` value itself is not retained as a default.

## Recommendation

Adopt a general rule: **Apex Code has no default functional dependency on a hosted
service the project does not operate.** Provider endpoints and GitHub operations the
user explicitly configures or invokes are not “defaults” under this rule. User-named
catalog and viewer endpoints are allowed and must be documented at the configuration
point.

Verification should prove a fresh runtime makes no catalog request, static models remain
available, a configured endpoint receives the existing validated overlay protocol,
`/share` always returns the exact Gist URL, and a preview is emitted only for an explicit
viewer configuration. Product docs and help must contain no `pi.dev` runtime default.
