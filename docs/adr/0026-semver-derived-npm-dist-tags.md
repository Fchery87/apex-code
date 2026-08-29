# ADR 0026 — npm dist-tags derive from the release version

**Status:** Accepted · **Date:** 2026-08-29

## Decision

The release workflow publishes versions with a SemVer prerelease component under
`next` and versions without one under `latest`. Both Apex-owned packages use the same
derived tag in the same release. The workflow must not hardcode one tag for every
version.

As a one-time repair, `latest` moves from the deprecated `0.0.1-alpha.0` to
`0.0.1-alpha.10` before a stable release exists. This exception makes the unqualified
install select the newest verified build instead of a build the registry itself marks
stale. Once a stable version is published, the SemVer-derived workflow makes `latest`
mean stable and keeps later prereleases on `next`.

## Context

The release pipeline previously used `npm publish --tag next` unconditionally for both
packages. As a result, `latest` remained on the first deprecated alpha, while the
README taught `@next`. It also meant a future stable release could not become the
unqualified install without editing the workflow during the release.

## Alternatives

- **Always publish to `next`.** Rejected because it preserves the live stale-`latest`
  defect and provides no stable-release path.
- **Always publish to `latest`.** Rejected because later alphas, betas, and release
  candidates would replace the stable default.
- **Require a manual workflow input.** Rejected because a mutable operator choice can
  disagree with the immutable version tag. SemVer already carries the needed intent.

## Consequences

- A stable tag such as `v1.0.0` publishes both packages under `latest` without a
  workflow edit.
- A prerelease such as `v1.1.0-beta.1` publishes both packages under `next`.
- Moving the existing registry tags remains an authenticated npm operator action. The
  exact commands and verification step live in `docs/release-governance-checklist.md`.
- Workflow tests assert the derivation and both publish commands so the former
  hardcoded-tag defect cannot return unnoticed.
