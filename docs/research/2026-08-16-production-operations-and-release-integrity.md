# Phase 12 research: production operations and release integrity

**Date:** 2026-08-16  
**Scope:** production graduation for a sole-maintainer Apex Code project. This note uses
only the Apex Code repository and first-party GitHub, npm, and Node.js documentation.
It is research, not a Phase 12 specification or a claim that the controls below exist.

## Executive finding

Apex Code already has a credible *publication mechanism*: tag-triggered CI, npm Trusted
Publishing, provenance, a clean registry install on Linux and macOS, a frozen-upstream
boundary, and pinned GitHub Actions. It does **not** yet have a production operating
contract. In particular, the repository does not say which releases receive security
fixes, give severity-based vulnerability targets, define a compromised-release
runbook, continuously exercise real provider APIs, schedule upstream review, or state
how breaking changes are announced. Artifact verification is performed once during a
release but is not documented as a reproducible consumer/maintainer procedure, and the
release workflow does not create a GitHub Release or attach a canonical packed artifact
and checksums.

For a sole maintainer, production graduation should prefer small, automatable controls
and explicit bounded promises. Avoid an enterprise-shaped process that cannot be kept.
The minimum viable contract is: one supported release line, one supported Node LTS
floor, two supported OSes, severity targets defined as *triage and first-response*
rather than guaranteed fix times, automated dependency/provider canaries, a rehearsable
npm compromise runbook, and provenance/checksum verification recorded for every release.

## 1. Repository baseline (verified from this tree)

### What already exists

- Root `package.json` requires `node >=22.19.0`; both published package manifests repeat
  that engine. `README.md` says Node 22.19.0+, Linux and macOS have supported sandbox
  backends, and Windows CLI portability is exercised but Windows sandbox enforcement is
  unsupported. ADR 0005 is the security-boundary authority.
- `.github/workflows/ci.yml` builds, checks, and tests Ubuntu, macOS, and Windows on
  Node 22. The sandbox/product support statement is therefore intentionally narrower
  than the portability matrix.
- `.github/workflows/release.yml` triggers on `v*`, validates tag/package identity,
  uses an npm environment, grants `id-token: write`, and publishes both public packages
  with `npm publish --provenance --tag next`. It waits for the core package and clean-
  installs the exact CLI version on Ubuntu and macOS, then checks `apex-code --version`.
- All GitHub Actions in the two workflows are pinned to full commit SHAs. The checkout
  uses `persist-credentials: false` in the publishing job.
- Phase 0 evidence records a real npm install, npm registry signature/attestation audit,
  and a provider turn for `0.0.1-alpha.0` (roadmap, release run 31326901954).
- `SECURITY.md` provides private vulnerability reporting through GitHub and describes
  scope well. It only promises acknowledgement “within a few days”; it does not name
  supported versions, severity classification, triage targets, update cadence, or
  disclosure lifecycle.
- ADR 0003 requires merging every upstream minor release (batching only releases that
  land within days), and `docs/upstream-log.md` records the first merge. There is no
  scheduled workflow or documented recurring maintainer check, so adherence presently
  depends on memory.
- `packages/coding-agent/CHANGELOG.md` has one Apex release entry and retains attributed
  upstream history. The current release script is still substantially upstream-shaped:
  comments/output mention Pi and `pi.dev`, it derives its version from
  `packages/ai/package.json`, runs `./test.sh`, and pushes directly. The actual tag CI
  only publishes npm packages; it does not create GitHub Releases.
- Only `ci.yml` and `release.yml` exist. There is no Dependabot configuration, CodeQL,
  dependency-review workflow, scheduled provider canary, or release-compromise runbook.

### Important distinction

A successful mocked provider test proves Apex Code's adapter behavior, not that a
provider's live authentication, endpoint, streaming protocol, or model identifier still
works. Conversely, continuously running the full suite against billable providers is
costly and flaky. Production needs a small live canary layer in addition to deterministic
unit/integration tests.

## 2. Supported-release policy

GitHub's security-policy guidance explicitly recommends telling users which versions
are currently supported, using a version table, and how to report a vulnerability:
<https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository>.
GitHub private vulnerability reporting lets reporters submit privately and maintainers
collaborate in a temporary private fork before publication:
<https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/about-repository-security-advisories>.

**Recommended bounded promise:**

1. Until `1.0`, support **only the newest published Apex Code prerelease**. State this
   plainly; do not imply long-term support for every alpha.
2. At `1.0`, support the latest major release's newest minor/patch only. If Apex Code
   later has enough users and capacity, add the immediately previous major for critical
   fixes; do not promise that now.
3. Security fixes are released as a new immutable npm version. Never overwrite a
   published version. A vulnerable older version may be deprecated with an actionable
   message, but deprecation is not removal and users can still install it.
4. Put the version table in `SECURITY.md`, and keep npm dist-tags (`latest`, `next`) and
   README install guidance consistent with it.

This makes the support obligation measurable and sustainable for one person.

## 3. Vulnerability intake, triage, and targets

GitHub recommends private vulnerability reporting/security advisories for privately
reporting, discussing, and fixing repository vulnerabilities (links above). GitHub's
Dependabot documentation says alerts identify vulnerable dependencies and provide
severity and remediation information:
<https://docs.github.com/en/code-security/dependabot/dependabot-alerts/about-dependabot-alerts>.
Dependency review can block pull requests that introduce vulnerable dependencies:
<https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review>.

**Recommended sole-maintainer targets (calendar time):**

| Severity | Acknowledge | Complete initial triage | Target containment/fix | Public advisory |
| --- | ---: | ---: | ---: | --- |
| Critical (active compromise, credential theft, sandbox/permission bypass with broad impact, malicious release) | 24 h | 24 h | Contain immediately; fixed/revoked release target 72 h | After users have an actionable safe version, or immediately if exploitation requires warning |
| High | 2 business days | 3 business days | 7 days | Coordinated with reporter; normally with fix |
| Moderate | 5 business days | 10 business days | 30 days | With fix/release notes |
| Low | 10 business days | 20 business days | Next planned release | With fix/release notes |

These must be labeled **targets, not guarantees**. If the maintainer is unavailable,
`SECURITY.md` should say so through a dated status notice or a named backup contact.
Triage should record: affected supported versions; exploit preconditions; credential,
permission/sandbox and supply-chain impact; CVSS only if useful; owner; next update; and
whether npm/GitHub containment is needed. Enable Dependabot alerts and a weekly update
schedule, plus dependency review on PRs. Notification noise must be routed into one
weekly queue, with critical alerts delivered immediately.

## 4. Compromised npm release response

npm's official incident guidance says to reset the npm password, enable 2FA, inspect and
revoke tokens, inspect package metadata/team membership, remove unknown maintainers, and
contact npm support for assistance:
<https://docs.npmjs.com/reporting-a-vulnerability-in-an-npm-package/> and
<https://docs.npmjs.com/about-two-factor-authentication/>. npm unpublish is deliberately
restricted and can break the ecosystem; for most bad but non-qualifying releases npm
recommends deprecation instead:
<https://docs.npmjs.com/policies/unpublish/> and
<https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions/>.
Trusted Publishing exchanges GitHub's OIDC identity for short-lived publishing access,
eliminating a stored long-lived publish token; npm recommends provenance with it:
<https://docs.npmjs.com/trusted-publishers/> and
<https://docs.npmjs.com/generating-provenance-statements/>.

**Required runbook, rehearsed without touching a real release:**

1. **Declare and preserve evidence:** note UTC time, affected package/version/dist-tag,
   install counts if available, workflow run, commit/tag, registry metadata, provenance
   result, maintainer/team changes, and suspected credential path. Do not delete local
   evidence.
2. **Stop further publication:** disable the GitHub npm environment/workflow or require
   approval; revoke unknown npm sessions/tokens; reset npm and GitHub credentials; verify
   2FA; remove unknown package owners; review GitHub environment protection and OIDC
   trusted-publisher configuration.
3. **Warn without making matters worse:** move `latest`/`next` to the last known-good
   version when correct; deprecate the affected version with a concise “do not use;
   install X” message. Do not rely on dist-tag movement alone—exact-version installs and
   lockfiles remain affected.
4. **Unpublish only when npm policy permits and after weighing dependency breakage.**
   Contact npm support/security for malware, account takeover, or policy exceptions.
5. **Rebuild from a reviewed clean commit** into a *new version*, through the normal
   Trusted Publishing workflow. Verify provenance and package bytes before restoring
   the channel tag.
6. **Publish a GitHub Security Advisory and release note** naming affected versions,
   indicators, safe version, credential actions users need, and what was rotated.
7. **Post-incident:** establish root cause, affected time window, audit GitHub logs/npm
   access, rotate any possibly exposed provider/test credentials, and add a regression
   control. Record a blameless incident note.

A second npm owner can reduce lockout risk, but it also adds account-takeover surface.
For a true sole-maintainer project, prefer npm trusted recovery methods and a documented
succession path; if adding a backup owner, require strong 2FA and no routine publishing.

## 5. Release artifact integrity

npm provenance links a package to its source repository and build instructions using
Sigstore; `npm publish --provenance` generates the attestation in a supported cloud CI:
<https://docs.npmjs.com/generating-provenance-statements/>. npm also documents verifying
registry signatures and provenance with `npm audit signatures`:
<https://docs.npmjs.com/verifying-registry-signatures/>.
GitHub artifact attestations similarly establish build provenance and can be verified
with `gh attestation verify`:
<https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds>.
GitHub warns that pinning an action to a full commit SHA is the only immutable release
form for Actions:
<https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions>.

**Keep:** Trusted Publishing, `--provenance`, least workflow permissions, protected npm
environment, full-SHA Action pins, exact-version clean installs on both supported OSes.

**Add production gates:**

- `npm pack --json` both workspaces once, save the actual `.tgz` files, and record
  SHA-256, filename, package name/version, commit and workflow run. Current `--dry-run`
  checks contents but does not preserve the bytes that were reviewed.
- Before publish, unpack the tarballs in scratch space and run the CLI from packed
  contents. Publish those exact tarballs rather than invoking a second implicit pack.
- After registry visibility, download the exact versions into a fresh cache, verify
  name/version and SHA-512 integrity from npm metadata, run `npm audit signatures`, and
  compare a normalized repack/file manifest to the pre-publish artifacts. (Registry
  wrapping can make naïve tarball byte equality unsuitable; verify documented integrity,
  provenance, and content manifest.)
- Create a GitHub Release for the immutable tag with human release notes, checksums,
  third-party license report, and package manifest. If attaching tarballs, attest them
  with GitHub artifact attestations and document `gh attestation verify`.
- Protect release tags and the `npm` environment; require manual approval for the
  production `latest` channel, while `next` may remain automated. Ensure a tag is cut
  only from reviewed `main` and points to the versioned commit.
- Add an automated post-release verification job and a short human checklist. A release
  is not “done” until npm provenance/signature verification and Linux/macOS execution
  are recorded.

## 6. Provider regression detection

Repository unit tests already use fake providers and the replay harness, which should
remain the fast deterministic gate. Production adds two layers:

1. **Per-PR contract tests, no credentials:** fixture responses for authentication,
   streaming/tool calls, usage, retry/error classification, cancellation, provider
   registration, and model-catalog parsing. Ensure every built-in provider is present
   and every custom-provider public seam has a test.
2. **Scheduled live canaries:** at least weekly and before promoting `next` to `latest`,
   perform the cheapest supported request for the maintainable provider set. The
   minimum canary should test credential resolution, one streamed response, one tool
   call where supported, usage accounting, cancellation, and a known invalid-auth
   classification. Set strict per-run token/cost/time budgets, concurrency one, and no
   repository write permissions. Store credentials only in a protected GitHub
   environment, never expose them to fork PRs, and redact provider output.

Do not promise live coverage of every provider Apex inherits from upstream—one
maintainer cannot fund or credential that. Publish a provider support matrix:
“continuously canaried,” “contract-tested,” or “community/best effort.” A failing live
canary opens an issue and blocks stable promotion; it need not block unrelated PRs,
because provider outages are external and transient. Require two failures separated by
a retry before paging, except authentication failures, which should alert immediately.

GitHub scheduled workflows are appropriate but may be delayed under load and public-
repository schedules can be disabled after 60 days without repository activity, so the
process cannot silently assume exact timing:
<https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule>.

## 7. Upstream intake cadence

ADR 0003 already chooses “every upstream minor release” and requires recording conflict
hunks, files and time. Preserve that decision, but make it operational:

- Weekly scheduled check of the canonical upstream tags/releases; open or update one
  tracking issue. Never auto-merge upstream.
- Security releases: triage within 24 hours. Normal minor releases: start review within
  7 days. Closely spaced releases may be batched as ADR 0003 allows.
- Run the frozen-package boundary, complete three-OS CI, session migration tests,
  permission/sandbox invariants, provider contract tests, replay corpus, and pack/install
  gates before merge.
- Update `docs/upstream-log.md` in the merge commit with upstream version, conflict
  hunks separated by fork/identity/automation categories, touched forked files, elapsed
  time, and behavior/breaking changes inherited.
- After three post-Phase-2 merges, actually calculate the numeric ceiling ADR 0003
  deferred. If those merges do not yet exist, production graduation should call that
  missing evidence out rather than invent a threshold.

## 8. Breaking-change announcements

SemVer's official specification makes major versions the signal for incompatible API
changes; before `1.0.0`, the public API is not considered stable:
<https://semver.org/>. npm dist-tags can maintain separate stable and prerelease
channels:
<https://docs.npmjs.com/adding-dist-tags-to-packages/>.

**Recommended contract:**

- Maintain `next` for prereleases and introduce `latest` only at graduation. Never let
  an ordinary prerelease accidentally become `latest`.
- Every user-visible change gets a top-level Apex changelog entry; do not make users
  search the retained upstream history. Breaking entries begin with **BREAKING**, name
  affected config/CLI/API/session/provider behavior, provide before/after examples and
  migration steps, and say whether automatic migration exists.
- Before 1.0, breaking changes require a prerelease note and at least one release-cycle
  warning when feasible. At/after 1.0 they require a major version, except a security
  emergency where the advisory explains why compatibility was broken.
- Generate a GitHub Release from the changelog for every published version. For a
  breaking stable release, publish an announcement/discussion and keep the migration
  guide linked from README and the previous release notes.
- Runtime deprecation warnings must be bounded (once per process), actionable, identify
  the removal version/date, and never expose secrets. Avoid promising a deprecation
  window longer than the sole maintainer can support.

## 9. Supported Node and OS matrix

Node's official release policy says production applications should use Active LTS or
Maintenance LTS releases, and describes the six-month major cadence and LTS lifecycle:
<https://nodejs.org/en/about/previous-releases>.

**Recommended matrix at graduation:**

| Surface | Supported | CI obligation |
| --- | --- | --- |
| Node runtime | Node 22 Maintenance LTS and Node 24 Active LTS; package floor remains `>=22.19.0` while both pass | Full Ubuntu suite on both 22 and 24; macOS full suite on 22 plus install smoke on 24 |
| Linux | Current GitHub-hosted Ubuntu / documented modern distributions where Bubblewrap prerequisites are met | Full build/check/test, sandbox integration, exact package install |
| macOS | Current GitHub-hosted macOS and documented Seatbelt-capable versions | Full build/check/test, sandbox integration, exact package install |
| Windows | CLI portability preview only; **not a supported security/sandbox platform** | Continue build/check/test as a portability signal, but runtime must clearly say sandbox not enforced and docs must not call Windows fully supported |

Avoid an unbounded “Node >=22 forever” promise. Document that support follows Node LTS:
add a new Active LTS in CI, then announce and remove an EOL major in a semver-appropriate
release. Test the minimum declared version exactly (`22.19.0` or a container/toolchain
that pins it), not merely latest Node 22. Because dependencies can raise their engine
floor, package install should be included in the minimum-version gate.

OS support should name a policy rather than every distribution: current GitHub-hosted
Ubuntu/macOS plus best effort elsewhere, with runtime prerequisite checks. The security
claim must stay tied to the sandbox backend, not generic CLI startup.

## 10. Proposed Phase 12 exit evidence

Production graduation is checkable when all of the following are true:

1. `SECURITY.md` has the supported-version table, severity targets, advisory workflow,
   and maintainer availability/escalation statement.
2. A compromised-npm-release runbook exists and has a tabletop rehearsal record; npm
   owner/2FA/Trusted Publisher/environment settings have been manually audited without
   recording secrets.
3. Dependabot alerts/updates and dependency review are active; critical alerts have a
   defined notification route.
4. Stable and prerelease channels are explicitly defined; changelog and GitHub Release
   automation produces migration-ready notes.
5. CI tests the supported Node/OS matrix, including the exact Node floor; release gates
   install the exact registry version on Linux/macOS.
6. Release evidence includes packed-artifact manifests/checksums, npm provenance and
   `npm audit signatures`, GitHub Release assets/attestations where applicable, and a
   recorded post-publish smoke result.
7. Provider tiers are published; contract tests cover all built-ins and scheduled live
   canaries cover the declared continuously-supported tier under a protected, budgeted
   environment.
8. The upstream scheduled check and merge checklist exist; the upstream log is current,
   and ADR 0003's ceiling is calculated when sufficient post-divergence observations
   exist.
9. A release candidate passes these controls, is installed from npm on supported OSes,
   completes at least one canaried real-provider turn, and can be rolled back by moving
   the channel to a known-good immutable version.

## Primary-source index

### Repository

- `README.md`; `SECURITY.md`; root and published-package `package.json` files.
- `.github/workflows/ci.yml`; `.github/workflows/release.yml`.
- `docs/adr/0003-upstream-merge-cadence.md`;
  `docs/adr/0005-sandbox-boundary-guarantees.md`; `docs/upstream-log.md`;
  `docs/roadmap.md`; `packages/coding-agent/CHANGELOG.md`; `scripts/release.mjs`.

### Official external documentation

- GitHub security policy: <https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository>
- GitHub repository security advisories: <https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/about-repository-security-advisories>
- Dependabot alerts: <https://docs.github.com/en/code-security/dependabot/dependabot-alerts/about-dependabot-alerts>
- Dependency review: <https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review>
- GitHub Actions schedule: <https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#schedule>
- GitHub Actions hardening/action pinning: <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions>
- GitHub artifact attestations: <https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds>
- npm Trusted Publishing: <https://docs.npmjs.com/trusted-publishers/>
- npm provenance: <https://docs.npmjs.com/generating-provenance-statements/>
- npm registry signature/provenance verification: <https://docs.npmjs.com/verifying-registry-signatures/>
- npm package vulnerability reporting/account response: <https://docs.npmjs.com/reporting-a-vulnerability-in-an-npm-package/>
- npm 2FA: <https://docs.npmjs.com/about-two-factor-authentication/>
- npm unpublish policy: <https://docs.npmjs.com/policies/unpublish/>
- npm deprecation: <https://docs.npmjs.com/deprecating-and-undeprecating-packages-or-package-versions/>
- npm dist-tags: <https://docs.npmjs.com/adding-dist-tags-to-packages/>
- Node release/LTS policy: <https://nodejs.org/en/about/previous-releases>
- Semantic Versioning: <https://semver.org/>
