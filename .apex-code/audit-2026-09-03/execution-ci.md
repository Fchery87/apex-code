# CI, release, and dependency audit

Read-only audit of checked HEAD `2477e594ef1479d1cb4467f0bc50c2e14fcd3e00`, whose commit timestamp is `2026-09-04T21:11:42-04:00`. This audits the checked commit, not historical repository state on 2026-09-03. The artifact directory retains the original requested date. No application, test, or tracked configuration files were changed. No full suite or release was run. No prohibited source or `.worktrees` directory was inspected.

## Findings

### CI-1. High: release verification does not bind the published tarball to the tested tarball

Classification: confirmed release-integrity defect against the artifact contract. This is not evidence of a compromised release.

Prerequisites: a release workspace changes after the packed smoke gate, a publishing component substitutes package content, or a registry response is compromised. Ordinary pull-request authors do not gain publication access from this defect alone.

Evidence:

- `docs/adr/0018-apex-only-release-version-authority.md:28-38` requires the registry tarball hash or manifest to agree with what CI built and published.
- `scripts/apex/packed-product-surface.mjs:105-117` creates real tarballs. Its report retains the filename but discards the pack integrity/hash fields at `scripts/apex/packed-product-surface.mjs:197-203`. The smoke test installs these local files at `scripts/apex/packed-product-surface.mjs:283-303`.
- `.github/workflows/release.yml:175-198` publishes from package working directories, rather than publishing those tested tarballs. The verification command receives only package names and the commit SHA at `.github/workflows/release.yml:232-241`.
- `scripts/apex/verify-published-release.mjs:49-76` checks `gitHead` plus the presence of an attestation URL and a predicate-type string. It never downloads or verifies the signed attestation, subject digest, or workflow identity.
- `scripts/apex/verify-published-release.mjs:79-104` compares downloaded bytes only with the same registry's reported hashes. No expected local digest enters this check. It still prints that provenance is verified at `scripts/apex/verify-published-release.mjs:154-155`.

Consequence: the verifier accepts a self-consistent but unreviewed tarball carrying the expected `gitHead`. It also accepts a nonexistent attestation URL in the metadata check. The current check proves registry hash consistency and metadata presence, not the stronger tested-artifact/provenance claim.

Narrow remedy: preserve the pack integrity values, publish the exact tarball files that passed smoke tests, and compare downloaded registry bytes to those preserved values. Verify the attestation signature and expected subject/workflow identity through supported npm/Sigstore verification. Add negative tests for substituted content with matching registry hashes and missing or wrong signed provenance.

Check: the Node probe in the checks section returned no problems for fabricated metadata with unreviewed hashes and a nonexistent attestation URL. It exercised the real comparison exports without a network request or a publish.

### CI-2. Medium: an inherited release workflow remains active and violates the single release authority rule

Classification: confirmed wiring defect and excess release authority. Downstream exploitation is conditional because the current workflow has a broken archive-name contract.

Prerequisites: any pushed `v*` tag triggers it. Manual dispatch requires workflow execution permission. Abusing its release-write jobs requires getting their preceding jobs to complete, such as using the manual recovery `source_ref` to select compatible code. External environment protection and npm Trusted Publishing settings were not inspected.

Evidence:

- `.github/workflows/build-binaries.yml:3-16` enables both tag pushes and manual dispatch with a separate `source_ref`. Checkout uses that ref at `.github/workflows/build-binaries.yml:31-39`.
- The same tags trigger the intended workflow at `.github/workflows/release.yml:3-5`. Their concurrency groups differ at `.github/workflows/build-binaries.yml:20-22` and `.github/workflows/release.yml:7-9`.
- The inherited workflow calls the current archive producer at `.github/workflows/build-binaries.yml:66-76`, then requires `pi-*` archives at `.github/workflows/build-binaries.yml:93-104`. The producer writes `apex-code-*` archives at `scripts/build-binaries.sh:252-260`. If the build reaches payload preparation, these checks cannot pass with the current producer.
- Independent jobs retain `contents: write` at `.github/workflows/build-binaries.yml:202-209`, `387-415`, and `417-440`. They can create, publish, or delete draft releases. This contradicts `docs/release-governance-checklist.md:27-30`, which grants release authority only to `release.yml`'s `publish-binaries` job.
- The legacy npm path calls `scripts/publish.mjs` at `.github/workflows/build-binaries.yml:343-344`. That script validates only a dry-run pack at `scripts/publish.mjs:44-47` before its publish call at `scripts/publish.mjs:108`. It does not invoke the intended packed functional gate or post-publication verifier. This path references a different environment at `.github/workflows/build-binaries.yml:296-302`.
- Workflow regression tests scope themselves to `release.yml` at `scripts/release-workflow.test.mjs:6-10`. The test's whole-file publication count at `scripts/release-workflow.test.mjs:154-158` cannot detect another publishing workflow.

Consequence: tags start a redundant broken workflow. More importantly, the repository retains a second privileged release path outside the documented gates. The current asset mismatch is an accidental blocker, not an authorization control. I did not confirm that its npm OIDC identity is authorized, nor that it has ever successfully published in this fork.

Narrow remedy: delete the inherited workflow or reduce it to an explicitly non-publishing build check. Add a repository-wide workflow test that enforces one npm publication path and one job with release-write authority. Any needed recovery procedure should reuse the normal release gates rather than bypass them through `source_ref`.

## Positive controls and design limits

- CI tests Linux, macOS, and Windows from a checkout path containing a space. Actions are pinned to full SHAs. See `.github/workflows/ci.yml:54-71` and `97-110`.
- The frozen-package boundary has a dedicated CI job at `.github/workflows/ci.yml:28-42`, and the release checks it before build at `.github/workflows/release.yml:67-79`.
- Installs disable dependency lifecycle scripts at `.github/workflows/ci.yml:97-98` and `.github/workflows/release.yml:64-65`.
- The intended release declares a named npm environment, disables checkout credential persistence, publishes with provenance, and delays GitHub assets until the npm and macOS jobs succeed. See `.github/workflows/release.yml:20-26`, `175-198`, and `300-306`.
- Weekly root npm and GitHub Actions updates are configured at `.github/dependabot.yml:24-43`. Production high/critical audit failure blocks publication at `.github/workflows/release.yml:70-76`.
- A production audit returned zero known vulnerabilities. This is the current registry response for the root lockfile, not proof of absence of vulnerabilities or historical advisory state on 2026-09-03. No full/dev dependency audit or clean installed-product audit was run.
- The CLI ships its shrinkwrap at `packages/coding-agent/package.json:28-34`. CI checks both shrinkwrap and install-lock consistency through `package.json:17-21`.
- SBOM generation and packed-install license reports are configured at `.github/workflows/release.yml:135-159`. Their full closure was not re-generated during this audit.
- Unsigned standalone checksums are an explicit design tradeoff, not a newly discovered defect. `docs/specs/2026-08-25-standalone-release-installer.md:40-47` says independent signing is out of scope. The spec also explicitly chooses a Linux standalone `--version` check at lines 109-114. macOS npm verification does not prove macOS standalone functionality, but this is known coverage scope rather than a failed promised gate.
- Branch protection, npm environment policy, private vulnerability reporting, and actual npm Trusted Publishing bindings are external settings. `docs/release-governance-checklist.md:7-10` explicitly says its unchecked list is not evidence they are configured. This audit makes no claim about their live state.

## Exact checks and results

### Focused existing tests

Command:

```sh
node --test scripts/ci-workflow.test.mjs scripts/release-workflow.test.mjs scripts/apex/verify-published-release.test.mjs
```

Exit 0. The verifier tests include reads of an already-published upstream package from npm, and a temporary manifest that the test removes. They do not publish a package. Actual output:

```text
✔ checkPublishedMetadata passes when gitHead matches and provenance is attached (5.221737ms)
✔ checkPublishedMetadata catches a gitHead mismatch (0.876999ms)
✔ checkPublishedMetadata catches a missing gitHead entirely (0.654072ms)
✔ checkPublishedMetadata catches missing npm provenance (0.631085ms)
✔ checkPublishedMetadata catches an unexpected provenance predicate type (0.623798ms)
✔ checkTarballHash catches a shasum mismatch between registry metadata and downloaded bytes (1.028117ms)
✔ checkTarballHash catches an integrity mismatch between registry metadata and downloaded bytes (0.698996ms)
✔ checkTarballHash passes when both digests match (0.52536ms)
✔ fetchPublishedMetadata and hashTarball work against a real, already-published package (1105.18167ms)
✔ verifyPublishedPackage passes end to end for a real, already-published package with the right gitHead (810.765423ms)
✔ verifyPublishedPackage reports a gitHead mismatch for a real package with the wrong expected commit (684.379652ms)
✔ CLI --manifest-out writes durable release evidence for a real, already-published package (940.699656ms)
✔ CI requires three OSes from a spaced checkout with immutable actions (91.494379ms)
✔ Windows CI parses the standalone PowerShell installer (9.200455ms)
✔ release workflow is tag-triggered, least-privilege, and publishes only Apex-owned packages (153.661021ms)
✔ release derives the npm dist-tag through the tested selector, not inline shell (36.392592ms)
✔ release environment reference is present for external deployment-protection configuration (task 12.13) (35.992452ms)
✔ the frozen-package boundary check runs before any build/test/publish step (task 12.13) (38.383638ms)
✔ release workflow validates tag identity and clean-installs the published CLI (25.425934ms)
✔ packed-artifact identity and functional smoke gate runs before either publish step (ADR 0018, task 12.8) (23.932369ms)
✔ production dependency vulnerability audit and SBOM generation are required release gates (task 12.11) (19.196734ms)
✔ third-party license report is scoped to the packed production install, not the monorepo's own devDependencies (task 12.11) (13.227051ms)
✔ post-publication registry verification runs after both publish steps with the tag's commit SHA (ADR 0018, task 12.9) (16.50045ms)
✔ macOS verification job depends on publish, runs on the other supported platform, and never re-publishes (20.015727ms)
✔ standalone binaries are built and hashed before npm publication, then released only after macOS verification (18.272533ms)
✔ the standalone release job names the repository, having never checked it out (17.279621ms)
ℹ tests 26
ℹ suites 0
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3733.463036
```

### Comparison-boundary probe

Command:

```sh
node --input-type=module -e 'import {checkPublishedMetadata,checkTarballHash} from "./scripts/apex/verify-published-release.mjs"; const m={gitHead:"tag-sha",dist:{shasum:"unreviewed-sha1",integrity:"sha512-unreviewed",tarball:"https://registry.example/unreviewed.tgz",attestations:{url:"https://registry.example/missing-attestation",provenance:{predicateType:"https://slsa.dev/provenance/v1"}}}}; console.log(JSON.stringify({metadataProblems:checkPublishedMetadata(m,{gitHead:"tag-sha"}),tarballProblems:checkTarballHash(m,{shasum:"unreviewed-sha1",integrity:"sha512-unreviewed"})}));'
```

Exit 0. Actual output:

```text
{"metadataProblems":[],"tarballProblems":[]}
```

### Production dependency audit

Command:

```sh
npm audit --omit=dev --json --ignore-scripts --cache /tmp/apex-ci-audit-codicwqf
```

Exit 0. Used a temporary npm cache. Actual output:

```json
{
  "auditReportVersion": 2,
  "vulnerabilities": {},
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": 0,
      "high": 0,
      "critical": 0,
      "total": 0
    },
    "dependencies": {
      "prod": 172,
      "dev": 224,
      "optional": 84,
      "peer": 0,
      "peerOptional": 0,
      "total": 411
    }
  }
}
```

No full suite, build, release, install, `npm run check`, or TypeScript edits were performed. `npm run check` was intentionally not used because its Biome command writes files, see `package.json:17`.
