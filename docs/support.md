# Support policy

Apex Code is currently maintained by one person. This page states that honestly rather than
implying a staffed team, and gives the concrete commitments that stand behind it. The
underlying decision and its reasoning are in
[ADR 0014](adr/0014-sole-maintainer-production-operations.md); this page is the user-facing
summary.

## Maintainer

**Frantz Chery** is the accountable maintainer: security triage, release authorization, npm
publication and deprecation, provider-regression response, upstream merge review, supported
platform/version policy, and breaking-change communication.

**Succession**: if another maintainer is added, ownership transfers through a documented
repository change — [`ADR 0014`](adr/0014-sole-maintainer-production-operations.md),
`SECURITY.md`, release ownership configuration, and this page are all updated together, not
silently.

## What "best-effort" means here

All targets below are best-effort, not a contractual SLA. A single maintainer cannot honestly
promise 24/7 coverage or a guaranteed fix deadline. Targets may be missed when the maintainer
is unavailable; the commitment is to be honest about that when it happens, not to imply
staffing that does not exist.

| Area | Target |
| --- | --- |
| Security acknowledgement | Within 5 business days via [GitHub private vulnerability reporting](https://github.com/Fchery87/apex-code/security/advisories/new) |
| Critical security triage | Within 2 business days when available; otherwise as soon as practical |
| Security fix or mitigation | As soon as practical; disclosure coordinated with the reporter |
| Release authorization | No release without every artifact, install, platform, and security gate passing |
| Provider regressions | Detected via fake-provider contract tests and secret-free release smoke tests on every release; live provider checks are opt-in, never required for default CI |
| Upstream merges | Reviewed weekly; every upstream release is merged under ADR 0003 before it is depended on in a release |
| Breaking changes | Recorded in `CHANGELOG.md` and, for stable releases, GitHub release notes plus a README/support-policy update |

## Supported versions

Before 1.0, **only the latest non-deprecated Apex Code prerelease receives security support**.
Older alpha versions are test artifacts, not supported releases — upgrade before reporting an
issue against one.

## Platform and runtime support

- Node.js `>=22.19`
- Linux and macOS, including the OS-level sandbox backends (Bubblewrap on Linux, Seatbelt on
  macOS) — see [ADR 0005](adr/0005-sandbox-boundary-guarantees.md).
- Windows: CLI, build, and test portability are supported; OS-level sandbox enforcement is
  **not** — a standing exclusion under ADR 0005, not a gap awaiting a fix in this phase.

## If a published release is compromised or incorrect

npm versions are immutable — there is no in-place fix. See
[`docs/release-integrity-runbook.md`](release-integrity-runbook.md) for the exact recovery
sequence (deprecate, investigate, rotate, republish, re-verify, notify). ADR 0014's
"Compromised release" row is the ownership commitment behind it. The external GitHub/npm
settings the release pipeline depends on are tracked separately in
[`docs/release-governance-checklist.md`](release-governance-checklist.md).

## Reporting

- **Security vulnerabilities**: private disclosure only, via
  [GitHub private vulnerability reporting](https://github.com/Fchery87/apex-code/security/advisories/new).
  See [`SECURITY.md`](../SECURITY.md) for what is in and out of scope.
- **Bugs and feature requests**: [GitHub Issues](https://github.com/Fchery87/apex-code/issues).
