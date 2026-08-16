# Plan: Production graduation and release integrity

**Status:** Active — specification and sole-maintainer operating decision accepted; implementation not started.

## Purpose

Execute [`docs/specs/2026-08-16-production-graduation-and-release-integrity.md`](../specs/2026-08-16-production-graduation-and-release-integrity.md)
test-first. Technical security-boundary decisions land before implementation; artifact and
release gates consume those decisions rather than creating parallel policy. Human monitoring,
GitHub branch protection, and maintainer availability are documented commitments and are not
pretended to be test-verifiable.

## Task table

| ID | Task | Depends on | State | Commit / evidence |
| --- | --- | --- | --- | --- |
| 12.1 | Settle the credential/state ownership and sandbox handoff contract in an ADR. Define host-owned versus ephemeral state, allowed environment, credential projection, cleanup, and session persistence without widening mounts. | — | not started | — |
| 12.2 | Settle supervisor trust-policy precedence in an ADR. Ensure untrusted project settings cannot influence mounts, network policy, command/args, credentials, or executable resolution before trust; preserve ADR 0005 fail-closed behavior. | — | not started | — |
| 12.3 | Implement and test the credential/state handoff at the public CLI boundary. Prove sanitized environment construction, no forbidden host-path access, no secret/session leakage, and normal/crash cleanup on Linux/macOS; preserve Windows portability behavior. | 12.1, 12.2 | not started | — |
| 12.4 | Implement and test trust-first supervisor policy resolution. Add malicious project fixtures and explicit trusted-policy coverage; prove project settings cannot widen pre-child security authority. | 12.2 | not started | — |
| 12.5 | Settle the downloaded-resource integrity model in an ADR, then pin and verify executable tool artifacts. Use bounded downloads, archive/path validation, digest verification, quarantine, atomic promotion, and tamper rejection. | 12.2 | not started | — |
| 12.6 | Settle Apex-only version authority and release artifact contract in ADRs. The owned release set is exactly `apex-code-agent-core` and `apex-code`; define exact dependency, tag, tarball, branding allowlist, provenance, and fake-provider smoke requirements. | — | not started | — |
| 12.7 | Replace inherited workspace-wide release/version behavior with Apex-only tooling and integration tests. Frozen consumed packages must remain untouched. | 12.6 | not started | — |
| 12.8 | Add packed-artifact identity and functional gates. Pack exact tarballs, inspect metadata/README/dist/system prompt, run clean scratch installs and provider-independent sandbox/session smoke, reject secrets/absolute paths/unreviewed active Pi identity, and run before publication. | 12.6, 12.3, 12.4 | not started | — |
| 12.9 | Add post-publication registry verification and release evidence. Compare tag SHA, registry `gitHead`, tarball manifest/hash, npm provenance, and clean installs on supported platforms; document immutable-version compromise/deprecation recovery. | 12.7, 12.8 | not started | — |
| 12.10 | Add downloaded package/resource integrity policy for executable extensions and remote resources, if the implementation surface is covered by this phase; otherwise record a bounded follow-up rather than silently widening scope. | 12.2, 12.5 | not started | — |
| 12.11 | Add supply-chain evidence: dependency vulnerability policy, scheduled scanning, SBOM, complete transitive production license closure, and release artifact hash/provenance attachments. | 12.7 | not started | — |
| 12.12 | Publish the sole-maintainer support contract in `SECURITY.md`, `docs/support.md`, README links, and release documentation. Include Frantz Chery as accountable maintainer, best-effort targets, latest-prerelease support line, platform/Node matrix, upstream cadence, provider regression detection, breaking-change policy, compromise runbook, and succession. | — | not started | — |
| 12.13 | Add governance workflow checks that are enforceable in-repository: pinned actions, OIDC/no token fallback, required artifact gates, frozen boundary, and release environment references. Record external GitHub settings as maintainer checklist items rather than claiming them enabled. | 12.8, 12.9, 12.12 | not started | — |
| 12.14 | Run required verification: focused suites, `npm run build`, `npm run check`, full `npm test`, documentation lifecycle validation, local packed install, then required Ubuntu/macOS/Windows CI from a spaced checkout. | 12.3–12.13 | not started | — |
| 12.15 | Publish a corrected prerelease only after all artifact gates pass, verify the downloaded registry package, deprecate stale alpha versions, and record immutable release evidence. Do not claim stable production support from this prerelease. | 12.9, 12.14 | not started | — |

## Implementation order

1. 12.1 and 12.2: security authority decisions.
2. 12.3 and 12.4: state and supervisor boundaries.
3. 12.5: executable artifact integrity.
4. 12.6: release/version and packed-artifact contract decisions.
5. 12.7–12.9: release tooling and artifact gates.
6. 12.10–12.13: resource integrity, supply-chain evidence, support policy, and enforceable governance checks.
7. 12.14: complete verification.
8. 12.15: corrected prerelease publication and deprecation of stale artifacts.

## Exit evidence

Phase 12 may be marked landed only when the specification's exit criterion is met with:

- Technical ADRs for credential/state handoff, trust-policy precedence, resource integrity,
  Apex version authority, and release artifact identity.
- Deterministic Linux/macOS handoff and supervisor-boundary tests.
- Tool/resource tamper-rejection tests.
- Apex-only release tooling integration tests.
- Pre- and post-publication artifact identity and functional smoke evidence.
- Required three-OS CI and frozen-package proof.
- Published sole-maintainer security/support policy and succession path.
- Registry evidence for the corrected prerelease, including exact version, `gitHead`, and
  tarball identity.

## Order changes

None. The security-boundary decisions are intentionally scheduled before implementation;
artifact gates depend on the resulting handoff and trust contracts.
