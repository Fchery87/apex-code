# Release governance checklist

ADR 0018 (task 12.13) enforces what a workflow file can enforce: pinned action SHAs, no
long-lived npm token, required artifact gates in the right order, the frozen-package boundary,
and a named deployment environment — all covered by `scripts/release-workflow.test.mjs`.

**What a workflow file cannot prove is whether the GitHub repository settings it depends on are
actually configured.** This page is that maintainer checklist.

A ticked box here means someone checked the live setting on the date in its evidence line, not
that a workflow enforces it. Nothing below is self-maintaining: a setting can be changed in the
GitHub or npm UI without touching this repository, and no gate would notice. Re-check on the
cadence in "Reviewing this checklist" and correct the date, or the tick decays into a claim
about a configuration that has since moved.

Two items cannot be settled from a checkout at all, because they need npm account access rather
than registry or repository API access. They are annotated rather than ticked.

## GitHub repository settings

- [x] **Branch protection on `main`.** Require the `ci.yml` required Ubuntu/macOS/Windows jobs
      to pass before merging. Disallow force-push and branch deletion for `main`. The release
      path does not satisfy this and is not meant to; see "Recorded deviations" below.
      *Verified 2026-09-19:* `GET /repos/Fchery87/apex-code/branches/main/protection` reports
      required contexts `Frozen packages match upstream`, `ubuntu-latest`, `macos-latest`,
      `windows-latest` with `strict: true`, `allow_force_pushes: false`,
      `allow_deletions: false`, and `required_conversation_resolution: true`.
      `enforce_admins` is deliberately `false`; see "Recorded deviations".
- [x] **The `npm` deployment environment** (referenced by `.github/workflows/release.yml`'s
      `publish` job) exists and has:
  - [x] A deployment branch/tag policy restricted to `v*` tags — not "no restriction" and not
        `main` (a plain branch push must never be able to trigger `npm publish`).
        *Verified 2026-09-19:* the environment's only policy is `{"name": "v*", "type": "tag"}`,
        and `protected_branches` is `false`, so no branch qualifies.
  - [x] No environment secret named `NPM_TOKEN` or `NODE_AUTH_TOKEN` (or any long-lived npm
        credential). Publication authenticates via npm Trusted Publishing (OIDC,
        `permissions: id-token: write`) — a stored token would be a silent second path to
        publish that bypasses everything this environment's other protections are for.
        *Verified 2026-09-19:* the environment holds zero secrets of any name.
  - [x] Required reviewers, if the maintainer wants a manual gate on top of the automated ones,
        is a judgment call recorded here explicitly rather than left unconsidered — a
        sole-maintainer project may reasonably decide the automated gates are sufficient.
        *Settled:* decided against, with the reasoning and its cost under "The `npm` environment
        has no required reviewers" below. The tick records that the question was answered, not
        that reviewers exist.
- [x] **GitHub Release authority.** Only `.github/workflows/release.yml`'s
      `publish-binaries` job may hold `contents: write`. Do not give this permission to the
      npm publishing job or a general-purpose workflow; that would let a partial or unverified
      run publish downloadable executables.
      *Verified 2026-09-19:* within `release.yml`, `publish-binaries` is the only job granting
      it; the `publish` job's workflow-level default is `contents: read`. One other workflow
      holds it and is recorded under "Recorded deviations".
- [x] **Release asset review.** Confirm a tag's GitHub Release contains all six named
      `apex-code-<platform>` archives and `SHA256SUMS`, and that each checksum entry describes
      the matching uploaded asset before sharing the curl/PowerShell installer links.
      *Verified 2026-09-19 for `v0.3.0`:* all six archives plus `SHA256SUMS` are present.
      This one is per-release, so the tick ages out with every tag rather than persisting.
- [x] **GitHub private vulnerability reporting** is enabled for this repository (Settings →
      Code security → Private vulnerability reporting). `SECURITY.md` documents this as the
      reporting channel; the channel does not exist unless this is on.
      *Verified 2026-09-19:* `GET /repos/Fchery87/apex-code/private-vulnerability-reporting`
      returns `{"enabled": true}`.
- [x] **Dependabot alerts and security updates** are enabled (Settings → Code security).
      `.github/dependabot.yml` configures scheduled version-update PRs regardless, but the
      separate alerts feature is what surfaces a known vulnerability before a scheduled PR
      would.
      *Verified 2026-09-19:* `GET /repos/Fchery87/apex-code/vulnerability-alerts` returns 204,
      and the repository reports `dependabot_security_updates: enabled`.
- [x] **Dependency graph** is enabled (usually on by default for public repositories; required
      for both of the above).
      *Verified 2026-09-19:* implied by the alerts check above, which GitHub refuses to enable
      without it, and corroborated by Dependabot opening pull requests against this repository.

## npmjs.org settings (per package: `apex-code-agent-core`, `apex-code`)

- [x] **Trusted Publishing** is configured for this exact repository, workflow file
      (`.github/workflows/release.yml`), and environment (`npm`) — not a broader or looser
      binding than that.
      *Verified 2026-09-19:* `apex-code@0.3.0` and `apex-code-agent-core@0.3.0` both report
      `_npmUser` as `GitHub Actions <npm-oidc-no-reply@github.com>` with a `trustedPublisher`
      object naming `github`. That is npm's own record of a tokenless publish. Read the SLSA
      provenance attestation as build identity only: `--provenance` needs just
      `id-token: write` and works alongside a long-lived token, so it proves where the artifact
      was built and not how the publish authenticated.
- [ ] No classic or granular access token exists for either package that could publish outside
      the Trusted Publishing flow. An unused token is a live bypass, not a harmless leftover.
      *Not settleable from a checkout.* The registry exposes who published a version, not what
      credentials could have. This needs npm account access and stays open until the maintainer
      checks it in the npm UI and records the date here.
- [ ] Two-factor authentication is required for publishing on the npm account(s) with
      maintain/owner access to both packages.
      *Not settleable from a checkout,* for the same reason. Account settings are not public.

## Recorded deviations

Things that are true, deliberate, and would otherwise look like a finding. A checkbox above
asks whether a setting is configured. This section answers the separate question of whether
anything routinely goes around one.

### Releases push to `main` and bypass its required checks

`scripts/release.mjs` step 10 runs `git push origin main` directly. It is not a pull request,
so the four required status checks do not run on the two commits a release creates, `Release
vX.Y.Z` and `Add [Unreleased] section for next cycle`. GitHub reports this on every release
push:

```
remote: Bypassed rule violations for refs/heads/main:
remote: - 4 of 4 required status checks are expected.
```

Observed on the `v0.1.0` push, `8bb45bdc9..dcf69d284`.

This is not a gap in branch protection. Protection is configured and working, and it is the
maintainer's bypass privilege that lets the push through, which means the bypass travels with
the person rather than with the repository.

Accepted for two reasons. Both commits are mechanical, a version bump and the `[Unreleased]`
to `[X.Y.Z]` rewrite, with no source change to review. And `release.mjs` runs `npm run check`,
`npm run build:offline`, and the full `./test.sh` suite locally and aborts before committing
if any of them fail, so the content is tested even though the commits are not gated.

What this costs is worth naming rather than leaving implicit. The local run is one platform,
so a release commit reaches `main` without the macOS and Windows evidence a pull request would
have required. The tested tree is the one CI already passed before the release, and the delta
is a version string and a changelog heading, so the exposure is small. It is not zero.

Revisit this if `release.mjs` ever changes what it commits beyond the version and the
changelog, or if release authority stops being a sole maintainer under ADR 0014's succession
process. Routing releases through a pull request is the fix if either happens.

### A second workflow holds `contents: write`

`.github/workflows/refresh-model-data.yml` grants its `refresh` job `contents: write` alongside
`pull-requests: write`, so the Release-authority item above is true of `release.yml` and not of
the repository as a whole.

Found 2026-09-19 while verifying that item, and recorded rather than ticked around.

The job refreshes the vendored model catalogs and opens a pull request with them. It contains no
release step and calls nothing that creates one. What `contents: write` buys it is the push;
what the checklist worries about is that the same permission would also let a workflow upload
release assets, and permission scopes do not distinguish the two.

Accepted, narrowly. The workflow is first-party, its actions are SHA-pinned, and it runs on a
schedule rather than on untrusted input, so the path from it to a published asset requires
changing the workflow file, which is a reviewed change on a protected branch. The exposure is
that the blast radius of a compromised action inside it includes the releases, not only the
branch.

Revisit if that job ever consumes untrusted input, or if GitHub ships a finer-grained scope that
separates pushing from releasing. Moving the catalog refresh to a fork-and-PR pattern with no
write permission at all is the fix if either happens.

### The `npm` environment has no required reviewers

Decided, not overlooked. The environment gates publication on a `v*` tag and nothing else; no
human approval stands between `npm run release:minor` and a live publish.

Release authority is a single person under ADR 0014. A required reviewer would therefore be
that same person approving their own deployment, which is a self-approval wearing a review's
clothes. It would add a prompt to every release and stop nothing, because whoever can create
the tag can also click the button.

What does the work instead is a chain of automated gates that a person clicking approve would
not replicate. Publication authenticates through npm Trusted Publishing over OIDC with no
stored credential, so there is no token to leak or reuse. The workflow validates that the tag
identifies the commit it claims. A packed-artifact smoke test runs on macOS before publication,
a clean install is verified after it, and registry state is checked against the tag's commit
SHA once both publish steps finish. Only `publish-binaries` holds `contents: write`.

The environment's `v*` tag restriction is load-bearing for the above and was absent until it
was added ahead of `v0.3.0`; every release through `v0.2.1` ran against an environment with no
branch or tag policy at all. `v0.3.0` is the first release to exercise the restriction, and it
published cleanly through it.

What this costs is worth naming rather than leaving implicit. A required reviewer on a second
account is the only gate that would stop a compromised maintainer machine from publishing,
since the tag push and any approval would otherwise both originate there. That gate does not
exist and cannot exist while there is one maintainer. The window between tag push and publish
is the last point at which a release could be stopped, and nothing watches it.

Revisit this the moment a second maintainer exists under ADR 0014's succession process. That
is exactly when a required reviewer stops being a self-approval and becomes a real one, and it
is the cheapest point at which to turn it on.

## Reviewing this checklist

Re-check this list whenever `.github/workflows/release.yml`'s `environment:` name changes, a
new maintainer is added (ADR 0014's succession process), or after any incident investigated
under `docs/release-integrity-runbook.md` — a compromise investigation is exactly when a stale
external setting is most likely to be found.

Two rows age out on their own rather than waiting for one of those triggers. Release asset
review and the `latest` dist-tag are both per-release facts, so their evidence describes the tag
it names and nothing later. Confirm them against the new tag on every release and move the date.

The rest are standing settings. Re-read their evidence lines when you re-check: an undated tick,
or one whose date is older than the last time the repository's settings were touched, is a claim
nobody has stood behind recently and should be treated as unchecked.


## npm dist-tags

`.github/workflows/release.yml` maintains these. It publishes a prerelease under `next` and a
stable version under `latest` (ADR 0026), so a normal release needs no manual tag move.

- [x] **`latest` points at the newest stable version** on both `apex-code` and
      `apex-code-agent-core`, and never at a prerelease. Check with
      `npm view <package> dist-tags --json`.
      *Verified 2026-09-19:* both report `{"latest": "0.3.0"}` and neither carries a `next`
      tag. Like the release-asset row, this ages out with every tag.

Do not commit npm credentials or tokens.

This section once carried two `npm dist-tag add ... 0.0.1-alpha.10 latest` commands, a
one-time migration to move `latest` off a deprecated alpha. That migration is finished.
Running those commands now would point `latest` back at `0.0.1-alpha.10` and downgrade every
bare install, so they are deleted rather than left as history. As of `v0.1.0` both packages
report `latest` as `0.1.0` and neither carries a `next` tag.
