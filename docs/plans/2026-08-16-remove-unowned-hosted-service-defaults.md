# Phase 11 remove unowned hosted-service defaults

**Status:** Active — 1 settled, 4 implementation/verification tasks pending

This plan implements `docs/specs/2026-08-16-remove-unowned-hosted-service-defaults.md`
under ADR 0013. Task identifiers are stable. Work proceeds in vertical test-first
slices at the public seams named by the spec.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 11.1 Research, specification, and hosted-service decision | Done | pending commit | Permanent research, ADR 0013, active spec, roadmap entry, and this plan. |
| 11.2 Explicit remote model-catalog integration | Not started | — | Red: fresh runtime/update command and configured endpoint. Green: static default plus explicit host-agnostic overlay. |
| 11.3 Explicit share-viewer integration and honest Gist result | Not started | — | Red: optional resolver and `/share` output. Green: canonical Gist always, configured preview only. |
| 11.4 Product documentation and artifact audit | Not started | — | Help/README/user guide/env/changelog corrected; current packed surface rejects unowned defaults. |
| 11.5 Three-OS verification and closure | Not started | — | Local narrow/build/check/full gates, required matrix proof, durable outcome, plan deletion. |

## Order changes

None.

## Task 11.1 — research and decision

Capture exact egress and fallbacks from primary sources, compare options, settle ADR
0013, write the spec with its deletion inventory, and activate Phase 11 only after Phase
10 has exited.

## Task 11.2 — model catalog

At the `ModelRuntime.create()` and update-command seams, first prove that an unset
endpoint performs no catalog fetch and still exposes static models. Then prove an
explicit SDK/environment endpoint keeps the existing overlay protocol. Implement only
the endpoint selection and user-facing no-remote result needed to satisfy those tests.

## Task 11.3 — share viewer

At the optional URL resolver and interactive command seam, first prove unset, canonical,
legacy, conflicting, blank, malformed, and configured cases. Then make the viewer
optional and make `/share` always report the canonical secret Gist, adding preview text
only for an explicit valid viewer.

## Task 11.4 — product surface

Write the failing current-surface inventory before updating help and documentation.
Retain historical evidence and compatibility vocabulary; remove current instructions
that claim `pi.dev` is a default. Add an Apex changelog entry.

## Task 11.5 — verification and closure

Run the narrow suites, `npm run build`, `npm run check`, and root `npm test`. Push for a
real required Ubuntu/macOS/Windows run. Record exact SHA/run evidence in the spec and
roadmap, verify SHAs with `git cat-file -t`, then delete this completed plan.

## Shared implementation rules

- Do not access `c-code` or edit consumed packages.
- Tests that create sessions/state use scratch directories.
- No new hosted infrastructure or telemetry surface.
- An absent endpoint is a valid static/URL-only state, not an error.
- Do not weaken Windows sandbox restrictions.
