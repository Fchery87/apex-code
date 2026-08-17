# ADR 0018 — Apex-only release/version authority and artifact contract

**Status:** Accepted · **Date:** 2026-08-16

## Decision

The owned release set is exactly two packages, published in dependency order:
`apex-code-agent-core` (`packages/agent`), then `apex-code` (`packages/coding-agent`). All
version-bump, changelog, tagging, and publish tooling operates on exactly these two
packages. The six frozen, consumed Pi packages (`packages/ai`, `tui`, `client`, `protocol`,
`server`, `telemetry` — ADR 0001) are never targeted by release tooling: not by `npm version
--workspaces`, not by changelog mutation, not by lockstep-version validation. Their presence
in the workspace is a build/test dependency of the graft, not a release artifact, and
`scripts/apex/check-frozen-packages.mjs` already enforces byte-identity against the pinned
upstream tag — release tooling must not be the thing that defeats that check.

**Exact internal dependency.** `apex-code`'s dependency on `apex-code-agent-core` is an exact
version match, never a semver range. `scripts/apex/validate-release-tag.mjs` already enforces
this at the CI release gate (both packages share one version, and the tag matches it); this
ADR extends the same exactness requirement to every place a version is written, including the
version-bump tooling that runs before that gate.

**Tag and publish order.** A release is a single tag `v<semver>` applied after both package
versions match it. `.github/workflows/release.yml` publishes `apex-code-agent-core` first,
waits for registry visibility, then publishes `apex-code` — `apex-code` declares an exact
dependency on a version that must already be resolvable. Both publish with `--provenance`.

**Packed-artifact contract (owed by 12.8/12.9, decided here).** A release is not just "these
two package.json versions match a tag." It additionally requires, before publication: a real
`npm pack` of both packages, an inspection of the packed contents (README, compiled `dist/`
output, package metadata) against a reviewed compatibility/attribution allowlist rather than a
zero-tolerance string ban, and a provider-independent sandbox/session functional smoke test
run against the packed-and-installed artifact — not the source tree, because `dist/` is
generated and git-ignored and a source-only check (`scripts/product-surface.test.mjs`) cannot
observe what actually ships. After publication, the registry copy is independently
re-verified: tag commit SHA, registry-reported `gitHead`, and a tarball content
hash/manifest must agree with what CI built and published, not merely "did `--version` print
the right string."

**Inherited tooling is not exempt.** `scripts/release.mjs` and `scripts/sync-versions.js` are
carried over from upstream Pi's monorepo release process and, at the time of this ADR,
still assume every non-private workspace package (all eight, frozen and owned alike) shares
one version — `sync-versions.js`'s lockstep check currently fails outright against the real
tree (`apex-code`/`apex-code-agent-core` at `0.0.1-alpha.1`, the six frozen packages at
`0.84.1`), and `release.mjs` separately reads `packages/ai` (a frozen package) as "the"
current version and would call `npm version --workspaces`, bumping frozen `package.json`
files. Neither has ever completed a real Apex release; this is a real, previously-latent
defect, not a hypothetical one. Task 12.7 rewrites both to the two-package contract stated
above; carrying inherited tooling forward unexamined is exactly the failure mode this ADR
closes off.

## Consequences

- A version bump touches exactly `packages/agent/package.json`, `packages/coding-agent/
  package.json`, their `CHANGELOG.md` files, and the lockfile — never a frozen package's
  files.
- `sync-versions.js`'s lockstep validation and its dependency-specifier rewriting both key off
  `getPublicWorkspacePackages()` (already the single source of truth used by `publish.mjs`,
  `release-packages.mjs`, and `product-surface.test.mjs`), not a blanket "every non-private
  package" scan.
- The exact-dependency rewrite means any future internal dependency between the two Apex
  packages is written without a semver range, matching what the CI gate already requires.
- Packed-artifact identity and post-publication registry verification are load-bearing parts
  of "a release," not optional extras layered on afterward; a release that skips them is
  incomplete under this ADR even if the registry publish itself succeeds.

## Rejected alternatives

**Keep one repo-wide version and let frozen packages ride along.** Rejected: it directly
reintroduces the defect this ADR closes (frozen `package.json` files being rewritten by
release tooling), and a frozen package's version identity belongs to upstream Pi, not to an
Apex release.

**Allow a caret range from `apex-code` to `apex-code-agent-core`.** Rejected: a caret range
would let `npm install` resolve `apex-code` against a *different*, potentially unpublished or
unreviewed `apex-code-agent-core` version than the one actually tested and tagged together,
which is exactly the kind of drift the concrete trigger for this phase (a stale `next`
artifact) already demonstrated is not hypothetical.

**Trust `npm pack --dry-run` validation (already run in CI) as sufficient artifact identity
proof.** Rejected: a dry-run pack proves the tarball *builds*, not that its *contents* are
what the maintainer believes they are — the concrete trigger for this phase was exactly a
tarball that packed successfully but shipped stale branding. Content inspection and a real
install/smoke test are additive, not redundant.
