# Spec: Production graduation and release integrity

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Status | `Active` |
| Created | 2026-08-16 |
| Last updated | 2026-08-16 |
| Roadmap phase | `12 — Production graduation and release integrity` |
| Tracking issue/PR | none |
| Governing decisions | ADR 0005, ADR 0006, ADR 0013, ADR 0014 |
| Compatibility posture | **Preserves compatibility by default.** Existing session files, `.apex-code` settings, CLI compatibility aliases, extension vocabulary, and consumed Pi package identifiers remain supported unless a separately recorded migration or security decision requires a change. Release tooling and security boundaries may reject unsafe states rather than silently preserve them. |

## Executive summary

Phase 12 moves Apex Code from a technically verified pre-alpha toward a product that can
be safely distributed and honestly supported. It closes the release-integrity gap that
allowed `apex-code@next` to serve an older Pi-branded artifact, repairs the sandboxed
credential/state and trust boundaries, verifies downloaded executable tools, and replaces
the inherited release path with an Apex-only process. It also records the operating model
for a sole-maintainer project: Frantz Chery is the accountable maintainer today, with
best-effort targets rather than an implied staffed support team.

Phase 12 does not claim that passing tests makes arbitrary model-driven code execution
safe. It defines the supported security boundary, release evidence, support policy, and
operational ownership required before a beta or stable release can be considered.

## Context and motivation

This phase follows the landed product surface and hosted-service work:

- [`docs/roadmap.md`](../roadmap.md) — Phases 0–11 are landed, but the published artifact
  is stale relative to current `main`.
- [`docs/research/2026-08-16-production-operations-and-release-integrity.md`](../research/2026-08-16-production-operations-and-release-integrity.md)
  — repository evidence and primary-source operational references.
- [`docs/adr/0014-sole-maintainer-production-operations.md`](../adr/0014-sole-maintainer-production-operations.md)
  — current ownership, response targets, supported release line, and succession policy.
- [`docs/adr/0005-sandbox-boundary-guarantees.md`](../adr/0005-sandbox-boundary-guarantees.md)
  — Linux/macOS sandbox guarantees and Windows exclusion.
- [`docs/adr/0013-no-unowned-hosted-service-defaults.md`](../adr/0013-no-unowned-hosted-service-defaults.md)
  — no implicit dependency on an unowned hosted service.
- [`docs/upstream-log.md`](../upstream-log.md) and ADR 0003 — upstream releases are reviewed
  and merged on the required cadence.

The concrete trigger is artifact drift. Registry `apex-code@next` currently points to
`0.0.1-alpha.1`, whose `gitHead` predates current `main`; its downloaded tarball contains
Pi-branded README and system-prompt content even though current source contains Apex Code
identity. Source-only product tests cannot detect this because `dist/` is generated and
ignored. The production audit additionally found that sandboxed sessions redirect state
away from global login, untrusted project settings can influence sandbox policy before
trust is established, and auto-downloaded `fd`/`rg` binaries lack pinned integrity data.

## Current state

| Surface | Current behavior |
| --- | --- |
| Published artifact | `.github/workflows/release.yml` publishes Apex packages from tags, but its post-publication check only verifies `--version`; no packed identity or functional session gate runs before publication. |
| Package ownership | `scripts/release-packages.mjs` correctly selects `apex-code-agent-core` then `apex-code`; inherited version tooling still reasons about all public workspaces and frozen upstream versions. |
| Branding | Current source and local build identify Apex Code in key surfaces, but active Pi prose remains in compatibility, historical, and some user-facing docs; no packed-artifact allowlist test exists. |
| Sandbox state | `packages/coding-agent/src/core/sandbox/cli-launch.ts` redirects `HOME`, XDG paths, agent state, and sessions under workspace sandbox directories, while `auth` is outside the child boundary. |
| Trust/policy | `packages/coding-agent/src/cli.ts` reads project network settings before the supervisor launch; project-controlled policy must not widen an untrusted security boundary. |
| Downloaded tools | `packages/coding-agent/src/utils/tools-manager.ts` follows mutable latest GitHub releases and installs archives without pinned digest/authenticity verification. |
| Operations | `SECURITY.md` has a private disclosure path but does not yet state the accountable maintainer, target, supported release line, or compromised-release procedure. |
| Supply chain | Actions are SHA-pinned and npm uses Trusted Publishing, but dependency scanning, SBOM generation, and complete transitive license closure are not release gates. |

## The problem

A user can install a registry artifact that is not the source they believe they are
installing, and the release process does not detect that mismatch before publication.
Separately, the documented login flow can configure credentials in host-global state that
the sandboxed provider session cannot read. An untrusted repository can influence the
supervisor's network policy before its trust decision is complete, and startup may fetch
and execute an unverified third-party binary. These are concrete release, security, and
support failures rather than future polish.

## Goals

- [ ] A new release is built from a tag whose commit, package versions, exact core dependency,
      packed contents, provenance, and registry `gitHead` agree.
- [ ] Packed and installed artifacts render Apex Code as the active product in welcome,
      startup, help, system-prompt, update, and exported user-facing surfaces. A reviewed
      allowlist preserves Pi compatibility, attribution, historical, and manifest vocabulary.
- [ ] Pre-publication Linux and macOS artifact installs run a real provider-independent
      sandbox/session smoke test; post-publication fresh-registry verification repeats the
      artifact and identity checks on supported platforms.
- [ ] Global authentication and sandboxed provider sessions have a documented, tested,
      least-privilege handoff; credentials are not copied into the repository workspace.
- [ ] Untrusted project settings cannot widen sandbox mounts, network policy, credential
      access, or executable resolution before trust is established.
- [ ] Downloaded executable tools use reviewed versions and pinned digests with bounded,
      atomic, archive-safe installation and mismatch rejection tests.
- [ ] The release path versions and publishes only the two Apex-owned packages without
      mutating frozen consumed packages; an integration test exercises it without publishing.
- [ ] Security/dependency scanning, SBOM output, complete production dependency licensing,
      and release exceptions are explicit and auditable.
- [ ] `SECURITY.md` and support documentation name Frantz Chery as the current accountable
      maintainer, state best-effort response targets, supported release/platform lines,
      compromised-release handling, provider regression detection, upstream cadence, and
      breaking-change communication.
- [ ] The repository has a documented succession path that changes ownership explicitly when
      another maintainer assumes the role.

## Non-goals

- [ ] A 24/7 support SLA or guaranteed remediation deadline; one maintainer cannot honestly
      provide that coverage, so targets remain best-effort.
- [ ] Windows sandbox enforcement in this phase; Windows remains a portability target under
      ADR 0005 unless a separate decision and backend implementation land.
- [ ] A project-hosted telemetry, model catalog, share viewer, or incident platform; ADR 0013
      remains in force.
- [ ] Automatic redaction of session exports or a claim that prompt injection is prevented.
- [ ] Supporting every historical alpha indefinitely; before 1.0, only the latest non-deprecated
      Apex prerelease receives security support.
- [ ] Renaming frozen Pi packages, extension API identifiers, manifest fields, legacy paths,
      or compatibility environment aliases without a separate migration decision.

## Proposed solution

| Workstream | Change | Primary files / evidence |
| --- | --- | --- |
| Artifact identity | Add a tarball-level product-surface checker with an explicit compatibility-aware allowlist; test packed README, compiled system prompt, startup strings, package metadata, and stale active defaults. | `scripts/apex/packed-product-surface.*`, `scripts/product-surface.test.mjs`, release workflow |
| Release provenance | Verify tag SHA, package `gitHead`, exact tarball bytes, provenance, and clean registry installs; move functional smoke before publication and retain post-publication verification. | `.github/workflows/release.yml`, `scripts/release-packages.mjs`, release tests |
| Apex-only versioning | Replace inherited all-workspace version assumptions with a two-package lockstep release path that never rewrites frozen packages; support prerelease semver and temp-repository integration tests. | `scripts/release.mjs`, `scripts/sync-versions.js`, new release tests |
| Credential/state handoff | Define explicit read-only credential/session handoff into the sandbox, preserving host-global ownership and workspace containment; prove login → provider turn → restart/resume. | `src/core/sandbox/*`, `src/cli.ts`, auth/session tests |
| Trust boundary | Resolve trust before consuming project-controlled security policy; only trusted/persisted policy can reach the supervisor. | `src/cli.ts`, trust/settings/sandbox tests |
| Tool integrity | Pin tool release metadata per platform/architecture, verify bounded downloads and archive paths/digests before atomic install. | `src/utils/tools-manager.ts`, integrity fixtures/tests |
| Supply chain | Add dependency vulnerability scanning, SBOM generation, and a complete production dependency license closure with explicit UNKNOWN handling. | `.github/workflows/`, `scripts/apex/`, `NOTICE` |
| Operations | Publish the sole-maintainer policy, security targets, support matrix, release/deprecation procedure, upstream cadence, provider regression policy, and succession process. | `SECURITY.md`, `docs/support.md`, `docs/adr/0014-*`, README |

Forked-code changes must remain legible against upstream under ADR 0003. The common
permission and agent-loop seams are not changed by the operational work; sandbox policy
changes preserve fail-closed behavior and do not grant an untrusted project additional
capability.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| Inherited all-public-workspace release/version assumption | behavior | superseded by Apex-only two-package release ownership |
| Post-publication-only functional release check | behavior | superseded by pre-publication artifact install/smoke gates plus post-publication verification |
| Mutable unverified executable-tool download | behavior | superseded by pinned, verified, bounded installation |
| Implicit trust of project security policy before trust decision | behavior | superseded by trust-first policy resolution |
| Ambiguous unstaffed security/support posture | doc | superseded by ADR 0014 and support documentation |
| Nothing else is removed without a compatibility review; Pi ecosystem identifiers remain by explicit allowlist. | policy | retained |

## Risks

| Risk | Signal | Response |
| --- | --- | --- |
| Credential handoff widens host access | adversarial sandbox test reads or writes outside the intended credential projection | fail closed, remove the mount, revise the handoff design |
| Artifact gate misses a new branded surface | clean tarball smoke or allowlist test sees Pi product copy | block release and classify the string before changing it |
| Tool metadata becomes stale | pinned release disappears or checksum mismatch occurs | block install with a diagnostic and update reviewed metadata |
| Pre-release owner is unavailable | missed security target or untriaged report | publish status honestly, prioritize critical mitigation, and add an owner before stable release |
| Upstream changes silently alter a compatibility seam | upstream merge diff or frozen-package check changes unexpectedly | stop release, review merge, record hunk/churn evidence |

## Verification

Phase 12 is not complete until all goals have named tests or operational evidence. The
minimum release proof is a clean required Ubuntu/macOS/Windows CI run, pre-publication
artifact install and sandbox smoke on supported sandbox platforms, post-publication
registry tarball identity verification, and `node scripts/validate-docs-lifecycle.mjs`.
Operational ownership is proven by the committed policy and monitored disclosure path,
not by pretending a test can prove human availability.

## Rollout

This is a multi-workstream phase and needs an execution plan after this specification and
any required ADRs are accepted. ADR 0014 settles current sole-maintainer ownership. Any
credential handoff or trust-boundary design that changes the security authority model must
receive its own ADR before implementation. The first implementation slice should be the
packed-artifact regression gate and a corrected prerelease, but it must not weaken the
remaining production blockers or imply stable support.
