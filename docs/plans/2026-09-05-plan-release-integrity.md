# Plan: Release artifact integrity

**Status:** In progress

**Spec:** [`docs/specs/2026-09-05-security-boundary-remediation.md`](../specs/2026-09-05-security-boundary-remediation.md)

**Depends on.** Startup and trust remediation.

## How to read this

Read the [implementation handoff](../../.apex-code/audit-review-2026-09-05/implementation-handoff.md) for the recommended order and entry checks. The plan tables remain the only task status records.

This plan is one independently verified change. Check a task only when its evidence exists. The owner must preserve existing unrelated working-tree changes. No application code is changed while this plan remains a plan.

Each task starts with a failing public-boundary test. Run the focused check before the next task. Tests that create sessions, policies, workspaces, credentials, or release artifacts use scratch directories. Record the real commit SHA in the task table only after its check passes. Do not claim a full suite is green when a rerun only passes in isolation.

**Verification rule.** Tests alone are not sufficient verification. A task is verified only when its unit test, public-boundary run, and relevant performance or resource check are complete.

## Task table

| ID | Task | State | Verification |
|---|---|---|---|
| RI.1 | Make the tested packed tarball the only package publish input. | verified in `aa860294d42bbe4086d06756c861ea2071b0573d` | `node --test scripts/apex/publish-release-artifact.test.mjs`: the publisher selects one manifest record, rehashes the retained bytes immediately before publishing, and passes the retained tarball path to `npm publish`. A fixture that mutates the package directory after smoke testing does not change the publish input. `--manifest-out` requires `--smoke`, so a failed smoke leaves no publishable manifest. |
| RI.2 | Compare published bytes with the retained pre-publication digest. | verified in `aa860294d42bbe4086d06756c861ea2071b0573d`, offline only | `node --test scripts/apex/verify-published-release.test.mjs`: the downloaded tarball is compared by SHA-256 and by npm integrity against the retained pre-publication values, not only registry metadata. The registry `gitHead` expectation was removed because publishing a packed tarball means the registry never receives one. A live registry round trip is not proved; see Narrowed claims. |
| RI.3 | Verify signed provenance subject digest and workflow identity. | verified in `aa860294d42bbe4086d06756c861ea2071b0573d` against the real npm output shape | `node --test scripts/apex/verify-published-release.test.mjs`: after the official npm CLI accepts the signature, the verifier decodes `bundle.dsseEnvelope.payload` and checks subject digest, repository, workflow path, tag ref, and commit. Negative controls for a changed payload, subject, workflow, and commit all fail. The fixture reproduces npm 11.19.0's raw bundle array, confirmed by reading `pacote/lib/registry.js`. Signature authenticity is not provable offline. |
| RI.4 | Remove the legacy release-writing authority. | verified in `aa860294d42bbe4086d06756c861ea2071b0573d` | `node --test scripts/release-workflow.test.mjs`: `.github/workflows/build-binaries.yml` is deleted, `release.yml` is the only release-writing authority, `publish-binaries` is its only `contents: write` job, and no obsolete `pi-*` job can publish. |
| RI.5 | Run the release gates on the real artifact. | verified in `aa860294d42bbe4086d06756c861ea2071b0573d` for identity and ordering, not for a real run | `node --test scripts/apex/*.test.mjs scripts/release-workflow.test.mjs`: 131 tests, 127 pass, 0 fail, 4 skipped. Packed install, smoke, dependency audit, SBOM, license, standalone, and post-publication checks all consume the same manifest identity, and the standalone artifact survives upload and download with the layout the final job reads. The macOS packed functional smoke now gates publication rather than following it, but no macOS runner executed it; see Narrowed claims. |

## Files and boundaries

Implementation files: `.github/workflows/release.yml`, the deleted `.github/workflows/build-binaries.yml`, `scripts/apex/{packed-product-surface,publish-release-artifact,verify-published-release,generate-sbom,generate-license-report}.mjs`, and `scripts/apex/fixtures/npm-attestation-bundles.mjs`. Tests: the matching `*.test.mjs` files plus `scripts/release-workflow.test.mjs`. Documentation: ADR 0018 and `docs/release-integrity-runbook.md`.

This plan uses the same documented two-commit close as the startup plan: the implementation commit establishes the real SHA; the close commit records and verifies that SHA in every task row.

## Narrowed claims

These are the parts of the release path this repair does not prove. Each is a limit of offline verification, not a deferred task.

1. **No live registry round trip.** Every check runs against offline fixtures. The three real-network cases stay skipped and no publication occurred.
2. **Signature authenticity is not verified here.** The pinned npm CLI is trusted to accept or reject the signature. This plan verifies what the accepted statement says, not that the cryptography holds.
3. **macOS smoke success is unproved.** The workflow now gates publication on a real packed functional smoke rather than a post-publication `--version` check, and the ordering is tested. No macOS runner executed it.
4. **The license closure walks the installed production tree**, not a validated lockfile-derived closure.
5. **A forced smoke failure is not exercised end to end.** The gate that ties `--manifest-out` to `--smoke` is tested; a mid-run smoke crash is not.

## Exit conditions

- Every task row has a focused green check and a verified commit SHA.
- The public-boundary tests pass on the supported surface for this plan.
- `npx tsgo --noEmit` passes for TypeScript changes.
- The owner records any full-suite failure without relabeling an isolated rerun as a green full suite.
- Durable decisions are promoted to an ADR or the spec before this plan is deleted.

## Open decisions

Resolve only decisions needed by this plan. Record settled architecture in an ADR. Do not add compatibility shims for unsafe behavior.

## Order changes

None. Add a reason if execution changes the task order.
