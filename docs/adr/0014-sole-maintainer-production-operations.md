# ADR 0014 — Sole-maintainer production operations

**Status:** Accepted · **Date:** 2026-08-16

## Decision

Until Apex Code has additional maintainers, **Frantz Chery** is the accountable maintainer
for the Apex Code project. This role owns security triage, release authorization, npm
publication and deprecation, provider-regression response, upstream merge review, supported
platform/version policy, and breaking-change communication.

This is an operational assignment, not a claim that one person provides 24/7 support. All
response times below are best-effort targets and may be missed when the maintainer is
unavailable. The policy must identify the current owner honestly rather than imply an
unstaffed security or release team.

## Operating commitments

| Area | Current owner | Target / policy |
| --- | --- | --- |
| Security intake | Frantz Chery | Monitor GitHub private vulnerability reporting when available; acknowledge within 5 business days. |
| Security assessment | Frantz Chery | Triage critical reports within 2 business days when available; otherwise as soon as practical. |
| Security fixes | Frantz Chery | Release a fix or publish a mitigation decision as soon as practical; coordinate disclosure after a fix or agreed date. |
| Supported security line | Frantz Chery | Before 1.0, support only the latest non-deprecated Apex prerelease. Older alpha versions are test artifacts. |
| Release authorization | Frantz Chery | No release without green artifact, install, platform, and security gates. |
| Compromised release | Frantz Chery | Publish a higher patched version, deprecate the affected npm version, investigate provenance, rotate credentials where relevant, and notify users. npm versions are immutable. |
| Provider regressions | Frantz Chery | Use fake-provider contract tests and secret-free release smoke tests on every release; live provider checks are opt-in and never required for default CI. |
| Upstream merges | Frantz Chery | Review upstream releases weekly and merge every upstream release under ADR 0003 before depending on it in a release. |
| Breaking changes | Frantz Chery | Record in changelog and migration documentation; include GitHub release notes and README/support-policy updates for stable releases. |
| Platform support | Frantz Chery | Node.js >=22.19; Linux/macOS with supported sandbox backends; Windows CLI/build/test portability without sandbox-enforcement support. |

## Succession

If another maintainer is added, ownership transfers through a documented repository change:
update this ADR's incumbent, `SECURITY.md`, release ownership configuration, and the support
policy in the same reviewed change. Until that happens, contributors may report issues and
patches, but the accountable role remains with the named maintainer.

## Why

A sole-maintainer project cannot honestly promise team coverage, guaranteed response SLAs,
or parallel release operations. Explicit ownership still makes the security path monitorable,
gives users a clear expectation, and creates a deliberate handoff point if the project grows.
The targets are adapted from the project's pre-alpha risk and support posture, not represented
as a contractual service level.

## Rejected alternatives

**Imply a team or use an unowned alias.** Rejected because no team currently triages the
inbox and an alias would conceal the actual operational dependency.

**Promise 24/7 response or fixed remediation deadlines.** Rejected because a single maintainer
cannot guarantee availability; best-effort targets are more honest.

**Support every historical prerelease.** Rejected because it multiplies security backport
obligations before a stable compatibility policy exists.
