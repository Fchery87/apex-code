# Release governance checklist

ADR 0018 (task 12.13) enforces what a workflow file can enforce: pinned action SHAs, no
long-lived npm token, required artifact gates in the right order, the frozen-package boundary,
and a named deployment environment — all covered by `scripts/release-workflow.test.mjs`.

**What a workflow file cannot prove is whether the GitHub repository settings it depends on are
actually configured.** This page is that maintainer checklist. It is a list of things to
verify are true, not a claim that they already are — do not read this document as evidence that
any item below is enabled; read it as what to check.

## GitHub repository settings

- [ ] **Branch protection on `main`.** Require the `ci.yml` required Ubuntu/macOS/Windows jobs
      to pass before merging. Disallow force-push and branch deletion for `main`.
- [ ] **The `npm` deployment environment** (referenced by `.github/workflows/release.yml`'s
      `publish` job) exists and has:
  - [ ] A deployment branch/tag policy restricted to `v*` tags — not "no restriction" and not
        `main` (a plain branch push must never be able to trigger `npm publish`).
  - [ ] No environment secret named `NPM_TOKEN` or `NODE_AUTH_TOKEN` (or any long-lived npm
        credential). Publication authenticates via npm Trusted Publishing (OIDC,
        `permissions: id-token: write`) — a stored token would be a silent second path to
        publish that bypasses everything this environment's other protections are for.
  - [ ] Required reviewers, if the maintainer wants a manual gate on top of the automated ones,
        is a judgment call recorded here explicitly rather than left unconsidered — a
        sole-maintainer project may reasonably decide the automated gates are sufficient.
- [ ] **GitHub Release authority.** Only `.github/workflows/release.yml`'s
      `publish-binaries` job may hold `contents: write`. Do not give this permission to the
      npm publishing job or a general-purpose workflow; that would let a partial or unverified
      run publish downloadable executables.
- [ ] **Release asset review.** Confirm a tag's GitHub Release contains all six named
      `apex-code-<platform>` archives and `SHA256SUMS`, and that each checksum entry describes
      the matching uploaded asset before sharing the curl/PowerShell installer links.
- [ ] **GitHub private vulnerability reporting** is enabled for this repository (Settings →
      Code security → Private vulnerability reporting). `SECURITY.md` documents this as the
      reporting channel; the channel does not exist unless this is on.
- [ ] **Dependabot alerts and security updates** are enabled (Settings → Code security).
      `.github/dependabot.yml` configures scheduled version-update PRs regardless, but the
      separate alerts feature is what surfaces a known vulnerability before a scheduled PR
      would.
- [ ] **Dependency graph** is enabled (usually on by default for public repositories; required
      for both of the above).

## npmjs.org settings (per package: `apex-code-agent-core`, `apex-code`)

- [ ] **Trusted Publishing** is configured for this exact repository, workflow file
      (`.github/workflows/release.yml`), and environment (`npm`) — not a broader or looser
      binding than that.
- [ ] No classic or granular access token exists for either package that could publish outside
      the Trusted Publishing flow. An unused token is a live bypass, not a harmless leftover.
- [ ] Two-factor authentication is required for publishing on the npm account(s) with
      maintain/owner access to both packages.

## Reviewing this checklist

Re-check this list whenever `.github/workflows/release.yml`'s `environment:` name changes, a
new maintainer is added (ADR 0014's succession process), or after any incident investigated
under `docs/release-integrity-runbook.md` — a compromise investigation is exactly when a stale
external setting is most likely to be found.


## npm dist-tags

The release workflow publishes prereleases under `next` and stable versions under `latest` (ADR 0026).
An authenticated maintainer must move the existing tags once so bare installs stop selecting the deprecated alpha. Run:

```sh
npm dist-tag add apex-code@0.0.1-alpha.10 latest
npm dist-tag add apex-code-agent-core@0.0.1-alpha.10 latest
```

Verify both with `npm view <package> dist-tags --json`. Do not commit npm credentials or tokens.
