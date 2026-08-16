# Spec: Remove unowned hosted-service defaults

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Status | `Active` |
| Created | 2026-08-16 |
| Last updated | 2026-08-16 |
| Roadmap phase | `11 — Remove unowned hosted-service defaults` |
| Tracking issue/PR | none |
| Governing decision | ADR 0013 |

## Executive summary

Apex Code still selects two Pi-operated services without an Apex operator or service
contract: a `pi.dev` model-catalog overlay and the `pi.dev/session/` preview appended to
`/share`. Phase 11 removes both defaults without building infrastructure. Static model
data remains the reliable baseline; remote catalog refresh becomes an explicit
`APEX_CODE_MODEL_CATALOG_URL`/SDK choice. `/share` keeps its explicit GitHub Gist upload,
labels the result accurately as a secret Gist, and adds a preview only when
`APEX_CODE_SHARE_VIEWER_URL` is configured.

The evidence and option analysis live in
`docs/research/2026-08-16-hosted-service-defaults.md`; ADR 0013 settles the decision.

## Current state

Verified at `d47de47efe949c676822c76de9a7182c115dad59`:

| Surface | Current behavior |
| --- | --- |
| Built-in catalog | `pi-ai/providers/all` supplies generated static providers and models. |
| Remote overlay | Every built-in except `radius` is wrapped with a default `https://pi.dev` endpoint; requests include provider ID and Apex User-Agent metadata. |
| Catalog fallback | Static and persisted newer data survive unavailable or transient remote responses. |
| Share upload | `/share` exports full session HTML and explicitly invokes `gh gist create --public=false`. |
| Share result | The command constructs `https://pi.dev/session/#<gist-id>` by default and also prints the GitHub Gist URL. |
| Configuration | Viewer override exists; SDK catalog override exists; ordinary CLI catalog override does not. |

## Goals

1. A fresh install makes no model-catalog request to `pi.dev` or any other
   project-selected catalog host.
2. Built-in static models and cached local state continue to work with no endpoint.
3. A user-named catalog endpoint retains the current validated overlay, retry, cache,
   freshness, cancellation, and offline behavior.
4. `/share` returns and accurately labels the exact secret Gist URL by default.
5. A preview URL appears only when a viewer is explicitly configured.
6. `/share` cannot invoke `gh gist create` before an affirmative disclosure/confirmation; cancel cleans temporary state.
7. Current help, README, user guide, environment reference, and packed npm artifact
   describe the real behavior and contain no `pi.dev` runtime default.

## Public seams and verification

The agreed test seams are the public runtime/configuration boundaries already exercised
by the repository:

| Seam | Required proof |
| --- | --- |
| `ModelRuntime.create()` / model registry | No configured endpoint means zero catalog fetches and usable static models; explicit option or environment endpoint performs requests against that base URL. |
| `apex-code update models` | Without a configured remote, reports that bundled catalogs are in use rather than claiming a refresh; with one, preserves forced refresh/error semantics. |
| Share publication and `getShareViewerUrl()` | No process starts before confirmation; cancel cleans up. The URL helper returns no viewer when unset; canonical environment wins over the legacy alias; configured bases produce one encoded/validated preview URL. |
| Interactive `/share` result | Secret Gist wording and canonical GitHub URL are always present; preview wording is conditional. |
| Product-surface inventory | Production sources and packed current docs contain no `pi.dev` default; reviewed historical/spec/ADR references remain allowed. |

## Proposed solution

### Model catalog

Make remote wrapping conditional in `ModelRuntime.create()`. Resolve the endpoint from
the explicit SDK `catalogBaseUrl` first, then `APEX_CODE_MODEL_CATALOG_URL`. With neither,
register the untouched built-in provider. Keep `APEX_CODE_OFFLINE` as the broader
network kill switch. Keep the overlay implementation host-agnostic and update its
comments/tests accordingly.

Register `APEX_CODE_MODEL_CATALOG_URL` with temporary `PI_MODEL_CATALOG_URL` compatibility
under Phase 10's published precedence, warning, and removal window. Bind persisted overlay
bodies and validators to their normalized source base URL; a different configured source
never receives another origin's ETag or cached body. Legacy entries without provenance are
accepted only when the explicitly configured source is the former `https://pi.dev` service.

### Share result

Replace the defaulted string helper with an optional viewer resolver. An unset or blank
viewer configuration yields no preview. Preserve canonical-over-legacy environment
precedence through the Phase 10 compatibility registry. Validate the configured base as
HTTP(S) and build the fragment without allowing the Gist ID to alter the configured
origin/path.

Before the explicit `gh gist create --public=false` operation, present a confirmation
that names GitHub, explains secret is not private/access-controlled, warns the HTML can
contain the complete transcript and tool/file content, and recommends reviewing a local
export. Decline/abort creates no Gist and cleans the temporary file. Change UI copy and docs
from private/share-viewer implications to “secret GitHub Gist,” always display its
canonical URL, and display “Preview” only when configured.

### Documentation and release surface

Update CLI help, environment reference, npm README, root user guide, privacy/network
text, changelog, and product-surface classification. Retained `pi.dev` strings must be
historical research/spec/ADR evidence, never current production or packed instructions.

## Non-goals

- Operating an Apex model-catalog service or share viewer.
- Removing static catalogs from the consumed `pi-ai` dependency.
- Changing provider API endpoints, npm update discovery, OTLP export, or telemetry ADRs.
- Making secret Gists private or adding encryption; GitHub owns that storage boundary.
- Removing the bounded `PI_SHARE_VIEWER_URL` alias before its published window.
- Changing Windows sandbox support.

## Deletion inventory

| Obsolete item | Disposition |
| --- | --- |
| `DEFAULT_CATALOG_BASE_URL = "https://pi.dev"` | Delete; remote wrapping requires explicit endpoint. |
| `DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/"` | Delete; viewer resolver becomes optional. |
| Help/docs claiming a retained upstream default | Replace with explicit configuration and secret-Gist disclosure. |
| Phase 11 execution plan | Delete on verified phase completion; durable evidence moves here and to the roadmap. |

No compatibility alias, consumed-package identifier, historical attribution, or old
changelog entry is deleted.

## Exit criterion

Required Ubuntu, macOS, and Windows CI passes install, build, check, and the full root
test suite from the asserted spaced checkout. Fresh-default tests prove zero remote
catalog/viewer selection; configured-endpoint tests prove both integrations still work.
The packed npm artifact has no current `pi.dev` runtime default, and the completed plan
is deleted after durable results are recorded.
