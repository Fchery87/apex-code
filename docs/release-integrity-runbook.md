# Release integrity runbook

Operational recovery steps for the release-integrity guarantees ADR 0018 establishes and
`.github/workflows/release.yml` enforces. Ownership and response targets are ADR 0014's; this
document is the concrete command sequence, not a restatement of policy.

npm versions are **immutable**. There is no "fix a published version in place." Every recovery
path below either publishes a new, higher version or removes the bad one from install
resolution — never both at once in a way that could leave a gap.

## Detecting a problem

A release is suspect if any of the following is true:

- `scripts/apex/verify-published-release.mjs` (the required post-publication CI step) reports a
  `gitHead` mismatch, a tarball hash mismatch, or missing npm provenance for a just-published
  version.
- `scripts/apex/packed-product-surface.mjs` would fail against the currently-published tarball
  if run against it directly (branding drift, a secret, or an absolute path shipped).
- A user reports the installed CLI behaving differently than the tagged source, or `npm view
  apex-code@<version> --json` shows a `dist.tarball` that does not match what CI's own build
  log recorded.

## Recovery: a bad or compromised version is live on the registry

1. **Do not attempt to overwrite it.** `npm publish` to an existing version number fails by
   design; npm does not support replacing a version's tarball in place.
2. **Deprecate the bad version** so new installs stop resolving it, without removing history:
   ```bash
   npm deprecate apex-code@<bad-version> "Compromised/incorrect build. Upgrade to <next-safe-version> immediately."
   npm deprecate apex-code-agent-core@<bad-version> "Compromised/incorrect build. Upgrade to <next-safe-version> immediately."
   ```
3. **Investigate provenance** before assuming compromise vs. build defect: compare
   `npm view apex-code@<bad-version> --json`'s `gitHead` against the tag's actual commit
   (`git rev-parse <tag>`), and diff that commit against `main` for anything unexpected.
   A `gitHead`/tag mismatch or an unattested (`dist.attestations` missing) publish is the
   strongest compromise signal, since Trusted Publishing normally makes an unauthorized
   publish from outside CI impossible.
4. **Rotate what could have been exposed** if compromise (not just a build defect) is
   confirmed: GitHub Actions OIDC trust is short-lived per-run and does not need rotation
   itself, but review repository/environment secrets, branch protection, and required
   reviewers for the `npm` deployment environment for signs of unauthorized access.
5. **Publish a corrected, higher version** through the normal path
   (`node scripts/release.mjs patch` or an explicit version), letting every gate in
   `.github/workflows/release.yml` run again in full — a compromised release is exactly the
   situation where skipping a gate to "ship the fix faster" is most dangerous.
6. **Verify the fix independently** after publish:
   ```bash
   node scripts/apex/verify-published-release.mjs \
     "apex-code-agent-core@<fixed-version>" "apex-code@<fixed-version>" \
     --git-head "$(git rev-parse v<fixed-version>)"
   ```
7. **Notify users.** Publish a GitHub Security Advisory (for a genuine vulnerability) or a
   GitHub Release note (for a build-integrity defect that was not a vulnerability), naming the
   affected version range and the fixed version. Update `docs/support.md`'s supported-version
   line once it exists (task 12.12).

## Recovery: an accidental publish (wrong version, wrong branch, premature)

Deprecation is usually sufficient; a wrong-but-not-dangerous publish does not need a security
advisory, only the same `npm deprecate` step above with a plain explanation, followed by
publishing the intended version.

## Recovery: the `next` dist-tag points at a stale or wrong version

`next` is a mutable pointer, not a version. Repoint it directly once the correct version is
confirmed good:

```bash
npm dist-tag add apex-code@<correct-version> next
npm dist-tag add apex-code-agent-core@<correct-version> next
```

## What this runbook does not cover

- Rotating the npm Trusted Publishing OIDC trust relationship itself (GitHub repository/environment
  settings, not a script) — a maintainer checklist item, see
  [`docs/release-governance-checklist.md`](release-governance-checklist.md).
- Windows release support — out of scope under ADR 0005 and this phase's stated non-goals.
- A staffed, 24/7 incident response process — ADR 0014 is explicit that this is a best-effort,
  sole-maintainer commitment, not a guaranteed response time.
