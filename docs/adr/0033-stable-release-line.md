# ADR 0033 — 0.1.x is a stable release line

**Status:** Accepted · **Date:** 2026-09-13 · **Amended:** 2026-09-14 (the decision is about
leaving pre-alpha, not about one minor line — see Amendment)

> **Amendment (2026-09-14).** This was written as "0.1.x is a stable release line" and the
> pages it changed copied that phrasing. `0.2.0` shipped the next day and every one of them
> became wrong, including two that ship inside the npm tarball. The decision never depended
> on the minor number: what graduated is the published line, whatever its version. The
> pages now say "stable" without naming a minor, and the support policy covers the latest
> non-deprecated release rather than the latest `0.1.x`. The title is left as written,
> because an ADR records what was decided on the day it was decided.

Apex Code's published versions are stable releases. `0.1.1` and everything after it on the
`0.1.x` line carry the ordinary compatibility expectations of a released package. The
"pre-alpha" label is retired from `README.md`, `SECURITY.md`, and `docs/support.md`.

## Decision

The project shipped a plain SemVer version and then described it as a prerelease. Those
cannot both be true, and the published artifact is the one users act on.

`0.1.1` has no prerelease component. ADR 0026 derives the npm dist-tag from the version, and
`scripts/apex/select-dist-tag.mjs` routes a version with no prerelease component to `latest`
under its ordinary rule. The registry says `latest = 0.1.1`. A user installing `apex-code`
gets it with no flag and no opt-in.

Meanwhile `README.md` said "pre-alpha ... APIs, configuration, and release practices may
still change" and "has published no stable version, so `latest` names the newest verified
prerelease". `docs/support.md` scoped security support to "the latest non-deprecated Apex
Code prerelease", and `scripts/apex/support-policy.test.mjs` asserted that exact sentence,
so a gate held the stale wording in place.

The contradiction is resolved in favor of the artifact. Declaring the line stable is the
smaller change and the honest one, because it describes what shipping already did.

## Why not stay pre-alpha

Keeping the label would mean making the artifacts match it: a prerelease component on every
future version and a non-`latest` dist-tag, so a plain `npm install` stops resolving to the
newest build. That is a real option and it was weighed. It was rejected because the project
has been publishing installable releases with release notes, provenance, an SBOM, a
published support policy, and a release-integrity runbook since `0.0.1`. The machinery is
that of a released product. The label was the only part still saying otherwise.

## What this commits to

- **Breaking changes owe users more than a changelog line.** Pre-1.0 SemVer permits a
  breaking change in a minor bump, and `0.1.0` used that permission to remove the OS
  boundary. That remains permitted. What changes is that a removal ships with the migration
  stated in the release notes and, where a setting or flag is involved, a diagnostic that
  names it. The `0.1.0` settings removal did not, and that defect is the reason this ADR
  exists rather than a separate cleanup.
- **Security support follows the stable line.** `docs/support.md` supports the latest
  non-deprecated `0.1.x` release rather than "the latest prerelease". ADR 0014's
  sole-maintainer, best-effort posture is unchanged, and this ADR does not promise a
  response time.
- **ADR 0026's amendment is spent.** That amendment let a prerelease hold `latest` "while
  no stable version exists". One exists, so the ordinary rule applies unchanged and the
  amendment now describes history.

## What this does not change

This is not a 1.0. The `0.x` major still signals that the shape of the product is moving,
and ADR 0003's fork cadence, ADR 0014's operations posture, and the roadmap's phase gates
are untouched. It also makes no claim about feature completeness; `docs/roadmap.md` remains
the record of what is implemented and how it was verified.
