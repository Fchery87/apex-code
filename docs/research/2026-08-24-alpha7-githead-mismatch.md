# Alpha.7 registry `gitHead` mismatch investigation

**Date:** 2026-08-24
**Status:** Resolved for the published artifact; local tag state requires cleanup before the next release.

## Finding

The published `0.0.1-alpha.7` packages were built from commit `5b8c4d661b022d005c60e9bd7394c6d2c1385d5a`, not from the local tag object `4eedb434c7ba00d50a786388867b6615a4067f59`.

This is a real ref divergence, not an npm metadata formatting problem:

- Local `v0.0.1-alpha.7` resolves to `4eedb434c7ba00d50a786388867b6615a4067f59`.
- `git ls-remote origin refs/tags/v0.0.1-alpha.7` resolves to `5b8c4d661b022d005c60e9bd7394c6d2c1385d5a`.
- GitHub's ref API independently reports the remote tag target as `5b8c4d661b022d005c60e9bd7394c6d2c1385d5a` ([tag ref](https://api.github.com/repos/Fchery87/apex-code/git/ref/tags/v0.0.1-alpha.7)).
- npm reports `gitHead: 5b8c4d661b022d005c60e9bd7394c6d2c1385d5a` for both [apex-code](https://registry.npmjs.org/apex-code/0.0.1-alpha.7) and [apex-code-agent-core](https://registry.npmjs.org/apex-code-agent-core/0.0.1-alpha.7).
- The two commits have the same release subject, timestamp, tree (`5df7a3000526c78696d6c5adfedb129f16b91380`), and release contents, but different parents. They are duplicate release commits created on two divergent histories, so they have different SHA-1 identities despite identical trees.

The registry artifact therefore matches the remote tag that GitHub Actions published. The mismatch was observed when comparing it with the stale/local tag resolution, which still points at the sibling commit.

## Why the release checks behaved this way

The release workflow passes `${GITHUB_SHA}` to `scripts/apex/verify-published-release.mjs`. The workflow run's tag-triggered GitHub ref was the remote tag target, `5b8c4d661b022d005c60e9bd7394c6d2c1385d5a`; npm's trusted publisher metadata and `gitHead` match that SHA. The verifier was correct to compare against the workflow SHA. A check against the local `v0.0.1-alpha.7` ref instead would report a mismatch even though the published artifact corresponds to the remote tag and its GitHub build.

The package metadata also carries npm provenance attestations, so the registry did not merely accept a manually repacked tarball: both package records identify GitHub Actions as the npm user and expose SLSA provenance URLs.

## Corrective action

Before the next release, fetch the remote tag and remove the duplicate local tag state, then verify the tag target and workflow SHA are identical before publishing:

```sh
git fetch origin tag v0.0.1-alpha.7 --force
git rev-parse v0.0.1-alpha.7^{commit}
git ls-remote origin refs/tags/v0.0.1-alpha.7
```

For this already-published version, do not republish or move the tag: the published package and remote tag are internally consistent. The release verifier's existing `--git-head "${GITHUB_SHA}"` gate is the right protection for future releases.
