# ADR 0026 — npm dist-tags derive from the release version

**Status:** Accepted · **Date:** 2026-08-29 · **Amended:** 2026-08-30 (a prerelease takes `latest` while no stable version exists — see Amendment)

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

## Amendment (2026-08-30)

**A prerelease publishes under `latest` while no stable version has ever been
published.** Once any stable version exists, the original rule applies unchanged and a
prerelease takes `next`. `scripts/apex/select-dist-tag.mjs` decides this from the
version and the registry's published list, so the behaviour flips on its own the moment
a stable version lands.

The original decision treated moving `latest` to `0.0.1-alpha.10` as a one-time repair
and assumed a stable release would move it next. That assumption does not hold for a
project that ships alphas. Under the unamended rule, `0.0.1-alpha.11` would publish to
`next` and leave `latest` on `alpha.10`, which is the same stale-`latest` defect this
ADR exists to close, one version behind instead of ten, and recurring on every alpha.

**One tag per release is a constraint, not a preference.** npm Trusted Publishing
authenticates `npm publish` and `npm stage publish` and nothing else; `npm dist-tag add`
requires traditional authentication ([npm docs, Trusted
publishers](https://docs.npmjs.com/trusted-publishers/), and npm/cli#8547 tracks the
request). Setting a second tag from the workflow would therefore require a stored npm
token, and `docs/release-governance-checklist.md` counts any such standing token as a
live bypass of the OIDC path. Given exactly one tag, `latest` wins it, because `latest`
is what a bare `npm install apex-code` resolves and a bare install must not receive a
stale build.

**`next` stops advancing while pre-stable, and that is the intended reading.** `next`
means "ahead of stable". With no stable line there is nothing to be ahead of. The
README and user guide move to the unqualified install for this period. A `next` tag left
pointing at an old alpha would be a stale pointer of exactly the kind this ADR removes,
so it is dropped rather than frozen, and it returns with the first stable release.

## Context

The release pipeline previously used `npm publish --tag next` unconditionally for both
packages. As a result, `latest` remained on the first deprecated alpha, while the
README taught `@next`. It also meant a future stable release could not become the
unqualified install without editing the workflow during the release.

## Alternatives

- **Always publish to `next`.** Rejected because it preserves the live stale-`latest`
  defect and provides no stable-release path.
- **Always publish to `latest`.** Rejected because later alphas, betas, and release
  candidates would replace the stable default. The 2026-08-30 amendment adopts this
  only while no stable default exists, which is the case it was rejected for not
  handling.
- **Publish to `next`, then set `latest` with `npm dist-tag add` in the same job.**
  Rejected on evidence rather than taste: OIDC cannot authenticate `dist-tag`, so this
  needs a stored npm token that the governance checklist forbids.
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
