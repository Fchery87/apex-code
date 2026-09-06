# Release Integrity Independent Verification

**Verdict: ISSUES — blocking runtime provenance wiring defect.**

## Blocking issue

### RI-B1: The verifier expects a decoded provenance `statement` that npm 11.19.0 does not return

- `scripts/apex/verify-published-release.mjs:69-86` searches `verifiedPackage.attestationBundles` and then reads `provenance.statement`.
- The pinned npm 11.19.0 implementation returns the registry attestation objects as `attestationBundles`. Their shape is `{ predicateType, bundle }`; the signed in-toto statement remains base64-encoded at `bundle.dsseEnvelope.payload`. npm decodes a local copy to verify it, but exposes the original raw objects in the audit JSON.
- Therefore a real `npm audit signatures --json --include-attestations` result reaches `checkVerifiedProvenance()` without `provenance.statement` and always fails with `official npm verification returned no signed SLSA provenance statement`.
- `scripts/apex/verify-published-release.test.mjs:175-225` does not catch this. Both its provenance fixture and fake npm output invent an `attestationBundles[].statement` field. They do not model the pinned CLI's real output contract. This is precisely a case where the workflow/string tests pass but runtime helper wiring is broken.

**Required repair:** After the official npm CLI has accepted the signature/attestation, decode and parse the verified provenance bundle's `bundle.dsseEnvelope.payload`, then check the retained expected subject digest, repository/workflow path/tag ref, and resolved commit on that parsed signed statement. Add an offline fixture with the actual npm 11.19.0 raw bundle shape and negative controls for payload/subject/workflow/commit changes.


### RI-B2: The opt-in public registry test still calls the removed CLI

- `scripts/apex/verify-published-release.test.mjs:118-146` invokes the old positional package target plus `--git-head` interface.
- The implementation accepts only `--release-manifest`, `--install-directory`, and `--manifest-out` (`verify-published-release.mjs:103-109`).
- Since this case is skipped unless `APEX_RELEASE_REGISTRY_TEST=1`, the default suite hides that the opted-in public-boundary path is guaranteed to fail at argument parsing. It cannot prove that a real npm 11.19.0 signed result passes.

### RI-B3: Required macOS packed functional smoke happens only after publication, and is only `--version`

- `docs/specs/2026-08-16-production-graduation-and-release-integrity.md:86-88` requires a prepublication Linux and macOS packed install with a real provider-independent sandbox/session smoke. Its verification clause repeats this at lines 161-164.
- `release.yml` runs the real packed functional turn only in the Ubuntu publisher. `verify-macos-install` depends on the completed publish job and tests only installation plus `apex-code --version`.
- The newer remediation spec does not repeal this accepted release requirement. The workflow can therefore publish npm packages before the required supported-platform functional gate.

### RI-B4: Manifest consumers do not validate one complete release identity

- `writeReleaseArtifactManifest()` enforces shared commit/workflow only while writing.
- `readReleaseArtifactDocument()` validates individual package-record field shapes, but does not require `releaseIdentity`, reconcile it with each record, enforce exactly the two owned packages, or validate uniqueness and shape of standalone entries.
- Publisher, SBOM/license tools, and postpublication verifier all consume this weaker reader. A malformed/substituted record can present contradictory release identities without rejection at the consumption boundary.

**Required repair:** validate the complete versioned document on read: exact owned package set with unique entries, one commit/workflow identity matching `releaseIdentity`, and well-formed unique standalone records.


### RI-B5: The manifest is written before the functional smoke succeeds

- `packed-product-surface.mjs:414-417` writes `release-artifacts.json`; only afterward do lines 419-431 install and smoke the packages.
- A failed smoke leaves a digest-valid manifest which `publish-release-artifact.mjs` accepts. The workflow process stops, but the record itself does not prove the ADR 0018 claim that its tarballs passed smoke, and the public publisher can consume the leftover record.
- Write the publishable record only after successful smoke, or include and enforce a gate result. Test that a failed smoke leaves no publishable manifest.

### RI-B6: Release-mode SBOM generation accepts empty or malformed evidence

- The normal SBOM path rejects malformed or near-empty component sets (`generate-sbom.mjs:82-94`).
- The release-install path at lines 118-124 parses, annotates, and writes without those checks. An offline fake-npm `{}` response exited 0 and wrote a 0-component SBOM.
- Apply the same structural and nonempty validation to release-mode output.

### RI-B7: Standalone identity does not enforce the expected archive set

- Manifest creation records whichever `.tar.gz` and `.zip` regular files happen to be present, including an empty or partial set.
- The final writer verifies only entries present in the downloaded record and `SHA256SUMS`; it does not reassert the expected six archive names/count.
- A shortened manifest/checksum can validate and produce a partial GitHub Release. Also, the final job never compares the downloaded manifest's `releaseIdentity` with the current `${GITHUB_SHA}`, `${GITHUB_REPOSITORY}`, workflow path, or `${GITHUB_REF}`. A self-consistent archive/manifest set from another commit, tag, or workflow can pass the handoff under the current tag.
- Use the existing exact-set contract from `prepare-binary-release.mjs` through manifest validation and final publication. At the final job, assert the manifest and all records share and match the current run identity.

### RI-B8: Mixed upload roots break the standalone publication job

- The `standalone-release-assets` upload mixes `${runner.temp}/binaries/...` with `${runner.temp}/packed-product-surface/release-artifacts.json` (`release.yml:140-145`).
- `actions/upload-artifact` preserves hierarchy relative to the paths' least common ancestor, now `${runner.temp}`. Downloaded files will be nested under `release-assets/binaries/` and `release-assets/packed-product-surface/`.
- The final job expects flat `release-assets/SHA256SUMS`, `release-assets/release-artifacts.json`, and `release-assets/apex-code-*` (`release.yml:329-344`). It will fail before creating the GitHub Release.
- Stage the manifest beside binaries before upload, or update every final validation path and upload glob. Add an offline path-layout test; the current regex workflow tests do not exercise artifact layout.

### RI-B9: License evidence omits nested production dependencies

- `collectPackageDirs()` reads only direct `node_modules` children and one scoped-name level (`generate-license-report.mjs:73-91`). It never walks nested dependency `node_modules` directories.
- Non-hoistable production versions can remain nested, so the release report is not the workflow's claimed “complete transitive production dependency license closure” (`release.yml:131-136`).
- Add nested dependency fixtures and traverse the installed production tree, while deduplicating by name and version, or derive the closure from a validated production dependency tree/lock.

### RI-B10: Registry `gitHead` will be absent because publication uses a packed tarball

- Live offline fixture: `npm pack --json --ignore-scripts` inside a git repository produces a tarball whose `package/package.json` has no `gitHead` field, and npm 11.19.0's `pacote`/`libnpmpublish` contain no `gitHead` injection code.
- The release flow packs once (`packed-product-surface.mjs`), then publishes the retained tarball file (`publish-release-artifact.mjs`), so the registry metadata for both Apex packages will have no `gitHead`.
- `checkPublishedMetadata()` treats a missing `gitHead` as a failure (`verify-published-release.mjs:48-50`). The real post-publication verification therefore fails on both packages before provenance checks, in the same after-publication position as RI-B1. Registry metadata "gitHead agrees with the tag commit" (ADR 0018, production spec) is unimplementable as written without recording the expected registry-side identity differently.
- Fixtures hide this because they hand-build `gitHead: "abc123"`. Fix either by publishing directory-side identity into the record and dropping the registry `gitHead` expectation, or by restoring a gitHead that the registry will actually receive. Add a fixture using a real packed-tarball shape with no `gitHead`.

### Process blocker: the owning plan remains unstarted

`docs/plans/2026-09-05-plan-release-integrity.md` still says `Not started`; RI.1–RI.5 remain `not started` with no verification evidence or commit SHA. Its startup/trust prerequisite is not closed. Per `AGENTS.md`, this cannot be accepted as completed work until the plan and verified commits truthfully record the result.

## Trace that otherwise passed review

- `packed-product-surface.mjs` creates one manifest from real tarball bytes. It records absolute tarball path, SHA-256, npm integrity, SHA-512 provenance subject digest, expected commit, workflow identity, and standalone archive hashes.
- The smoke install consumes those tarball paths. `publish-release-artifact.mjs` selects exactly one package record, rehashes retained bytes immediately before publishing, and passes the retained tarball path to `npm publish`. A package-directory mutation cannot change the publish input.
- Post-publication download hashing compares both SHA-256 and integrity with the retained prepublication values, in addition to registry metadata.
- The same smoke install and manifest feed production audit, license output, and SBOM identity. Standalone archives are recorded before upload and rehashed against that record after artifact download before `gh release create`.
- The intentional deletion of `.github/workflows/build-binaries.yml` removes its npm/GitHub release authority. Current workflow inspection found `.github/workflows/release.yml` to be the only npm/release writer; `publish-binaries` is its only `contents: write` job.

RI-B1 and RI-B2 leave the real signed-provenance path unproved/broken. RI-B3 permits npm publication before a required supported-platform functional gate. RI-B4 leaves the immutable record under-validated at its consumers. RI.3 and integrated RI.5 therefore cannot receive PASS.

## Focused offline check

```text
node --test scripts/apex/publish-release-artifact.test.mjs scripts/apex/verify-published-release.test.mjs scripts/apex/packed-product-surface.test.mjs scripts/release-workflow.test.mjs
```

Result: **46 tests, 41 passed, 0 failed, 5 skipped**. The skips are the opt-in registry/packed-smoke cases. This green result does not override RI-B1 because the provenance fixtures use the wrong runtime shape.

No network, registry publication, staging, commit, or prohibited source access occurred.

## RI remediation response (2026-09-06)

Owner: release-integrity implementation. Branch `main`, working tree only — nothing staged,
committed, published, deployed, or force-pushed. No network call to any registry. No live
credentials. The prohibited `c-code` tree was never opened, searched, or referenced.

### How to read the evidence below

Some findings were already repaired in the uncommitted tree when this owner picked the work
up — the verifier report was written at 16:13 on 2026-09-05 against source that had already
moved (for example `verify-published-release.mjs` was last written at 15:32 and already
contained `decodeProvenanceStatement`). Those rows are labelled **pre-existing repair,
mutation-proved**: the guard test was written or strengthened here, then the implementation
was reverted to exactly the audited-broken behaviour, the test was watched to fail, and the
implementation was restored. That is a real failing-first observation, but it is *not* a
claim that this owner authored the fix. Rows labelled **repaired here** were genuinely broken
in the tree and were fixed test-first.

Every command below was run offline on Linux with npm 11.19.0 / Node v24.15.0.

---

### RI-B1 — provenance statement shape — **repaired here (fixtures + controls); implementation was a pre-existing repair, mutation-proved**

**npm shape verified from source, not guessed.** Read in the installed pinned npm at
`$(npm root -g)/npm`:

- `node_modules/pacote/lib/registry.js:245-254` decodes `bundle.dsseEnvelope.payload` into a
  *local* `statement` variable and reads `bundle.dsseEnvelope.signatures[0].keyid` / `.sig`.
- `node_modules/pacote/lib/registry.js:344` then assigns `mani._attestationBundles = attestations`
  — the **raw** registry array of `{ predicateType, bundle }`, not the decorated `bundles` local.
- `lib/utils/verify-signatures.js:317` copies that into the result and `:60-66` emits
  `{ invalid, missing, verified }` with `verified[].attestationBundles`.

So `attestationBundles[].statement` cannot exist in real output. Confirmed.

**What changed.** New offline fixture `scripts/apex/fixtures/npm-attestation-bundles.mjs`
builds the real raw shape (both the keyless SLSA provenance bundle *and* the keyed npm publish
bundle, `mediaType`, `verificationMaterial.tlogEntries`, `dsseEnvelope.payloadType`,
`signatures[0].{sig,keyid}`, base64 in-toto payload), with the npm source citation in its
header. Three new tests in `verify-published-release.test.mjs`: the real-shape acceptance test
(which also asserts the fixture itself never grows a `statement` field), a test that a bundle
carrying *only* the invented decoded `statement` is **rejected**, and a table of negative
controls for changed payload, subject digest, subject name, workflow path, repository, tag ref,
and resolved commit. The fake npm inside "npm provenance verification invokes the pinned
official CLI offline" was also switched off the invented `statement` shape and now feeds its
parsed result straight into `checkVerifiedProvenance`.

**Failing first** — implementation reverted to the audited state
(`const statement = provenance?.statement;`):

```text
✖ checkVerifiedProvenance accepts npm 11.19.0's real raw attestation-bundle shape
    actual: [ 'official npm verification returned no signed SLSA provenance statement' ]
    expected: []
✖ a bundle carrying only the invented decoded `statement` field is rejected, not trusted
  AssertionError: The input did not match the regular expression
  /no decodable signed SLSA provenance statement payload/. Input:
  ''
✖ negative controls: a changed payload, subject, workflow, or commit fails the signed provenance check
  AssertionError: changed payload
    actual: 'official npm verification returned no signed SLSA provenance statement'
```

The second failure is the important one: with the audited code, a hand-written plaintext
`statement` with no signed payload behind it passed with **zero** problems.

**Passing after** (implementation restored):

```text
✔ checkVerifiedProvenance accepts npm 11.19.0's real raw attestation-bundle shape (1.146419ms)
✔ a bundle carrying only the invented decoded `statement` field is rejected, not trusted (0.802946ms)
✔ negative controls: a changed payload, subject, workflow, or commit fails the signed provenance check (3.647499ms)
```

**Deliberately narrowed.** "Changed payload" is tested as *undecodable / non-matching*, not as
*signature no longer valid*. Nothing here re-verifies a Sigstore signature: that is npm's job,
and offline it is only represented by `runNpmProvenanceVerification` refusing any result with
a non-empty `invalid[]`/`missing[]`. This suite therefore proves the verifier reads the right
field and enforces the right expectations on the decoded statement; it does **not** prove the
statement was cryptographically authentic. That still rests entirely on the pinned npm CLI
having run first, which only a real release can demonstrate.

---

### RI-B2 — opt-in registry test called the removed CLI — **repaired here**

The removed-CLI complaint was already addressed in the tree, but the two *fully offline* CLI
cases were still gated behind `APEX_RELEASE_REGISTRY_TEST=1` even though they make no network
call. Running them for the first time showed both were broken:

```text
✖ CLI verifies a manifest-shaped release end to end through fake npm and loopback tarball bytes
  ReferenceError: tarballServer is not defined
      at .../verify-published-release.test.mjs:224:3
✖ CLI fails closed when the registry serves bytes that differ from the retained manifest digest
  AssertionError: The input did not match the regular expression
  /does not match retained local sha256/. Input: ''
```

and, after hoisting the `const` out of the `try` so the real error surfaced:

```text
✖ CLI verifies a manifest-shaped release end to end ...
  AssertionError: /tmp/apex-verify-manifest-09lRDC/shim/npm: 1: Syntax error: "(" unexpected
  Command failed: npm --version
```

Three separate defects, none of which the default suite could see:

1. `tarballServer`/`substitutedServer` were declared inside `try` and referenced in `finally`.
2. The shim generator prepended a prelude **ahead of the shebang**, so `/bin/sh` executed the
   fake npm and every invocation failed.
3. The substituted-bytes case asserted on `result.stdout`, but the CLI only printed a summary
   line and buried the actual problems in the evidence JSON, so the reason for a red release
   job never appeared in the release log.
4. (Found while fixing.) The test drove the CLI with `spawnSync` while serving the tarball from
   its own loopback server in the same process — `spawnSync` blocks the event loop that has to
   answer the fetch, which is a deadlock, and is why the file hung instead of reporting.

**What changed.** Both CLI cases are ungated and run in the default suite. The shim is
generated from a JSON side-car with the shebang first (and asserted to stay first), the CLI is
driven asynchronously via `spawn`, servers are closed with `closeAllConnections()`, the
verifier now prints every problem to stderr, and a third case was added for a signed workflow
identity that disagrees with the release. The genuinely network-dependent
`@earendil-works/pi-ai` cases remain opt-in.

**Passing after:**

```text
✔ CLI verifies a manifest-shaped release end to end through fake npm and loopback tarball bytes (661.821177ms)
✔ CLI fails closed when the registry serves bytes that differ from the retained manifest digest (557.604651ms)
✔ CLI fails closed when the signed provenance names a different workflow than the release (567.747895ms)
```

**Deliberately narrowed.** These prove the CLI's *wiring* against a fake npm. They cannot prove
"a real npm 11.19.0 signed result passes" — that requires a published package and is
unavailable offline. The three real-registry cases stay behind `APEX_RELEASE_REGISTRY_TEST=1`
and were **not** run here (no network).

---

### RI-B3 — macOS functional smoke happened after publication — **pre-existing repair, mutation-proved (test added here)**

The tree already carried a `verify-macos-packed` job (`macos-latest`, runs
`packed-product-surface.mjs --smoke`) that `publish` depends on, but nothing tested it. Added
`a real macOS packed functional smoke gates publication, not just a post-publish --version
check`, which asserts `publish.needs` reaches a macOS job, that the job runs the packed gate
**with `--smoke`**, that it never publishes, and that it does not itself depend on `publish`.

**Failing first** (`needs: verify-macos-packed` removed from `publish`):

```text
✖ a real macOS packed functional smoke gates publication, not just a post-publish --version check
  AssertionError: publish must depend on a macOS job; it depends on []
```

**Passing after** (workflow restored):

```text
✔ a real macOS packed functional smoke gates publication, not just a post-publish --version check (50.648871ms)
```

**Deliberately narrowed.** This is a workflow-shape assertion. No macOS machine was available,
so nothing here proves the macOS smoke actually succeeds — only that the release cannot publish
without it having run. `verify-macos-install` (post-publish `--version`) is unchanged and
remains a second, weaker gate.

---

### RI-B4 — consumers did not validate one complete release identity — **pre-existing repair; a stale test it broke was repaired here**

`readReleaseArtifactDocument()` in the tree already enforces the versioned document, the exact
two owned packages with unique names, a `releaseIdentity` that every record matches, and the
exact six standalone archives, and `packed-product-surface.test.mjs` covers those cases.

That repair had left the suite **red**, which is how it surfaced here:

```text
✖ publisher passes the retained tested tarball to npm and rejects later byte changes
  Error: release artifact manifest must contain exactly apex-code-agent-core and apex-code packages
      at writeReleaseArtifactManifest (.../packed-product-surface.mjs:158:9)
      at TestContext.<anonymous> (.../publish-release-artifact.test.mjs:16:3)
```

`publish-release-artifact.test.mjs` was still building a one-package `apex-fixture` manifest —
a document the release can no longer produce. It was rewritten to build a complete, valid
record, and a second case was added proving the publisher itself refuses a drifted identity and
a truncated package set.

**Passing after:**

```text
✔ publisher passes the retained tested tarball to npm and rejects later byte changes (511.817548ms)
✔ publisher rejects a manifest that is not one complete, self-consistent release identity (157.274529ms)
```

---

### RI-B5 — manifest written before the smoke succeeded — **repaired here**

The tree had moved the manifest write after the smoke, but nothing tested the invariant and
`--manifest-out` without `--smoke` still produced a publishable record with no smoke behind it
at all. Added one exported decision point, `releaseManifestGate()`, as the only thing that
authorises a publishable record; the CLI now refuses `--manifest-out` without `--smoke` before
packing anything.

**Failing first:**

```text
SyntaxError: The requested module './packed-product-surface.mjs' does not provide an export named 'releaseManifestGate'
✖ scripts/apex/packed-product-surface.test.mjs (670.764419ms)
```

**Passing after:**

```text
✔ no publishable release record exists unless the functional smoke actually passed (96.831871ms)
✔ the CLI refuses to produce a publishable record without running the smoke at all (600.295541ms)
```

**Deliberately narrowed — read this one.** The "smoke ran and failed ⇒ no record" branch is
proved at the gate function, plus a real CLI run for the "no smoke requested" branch. It is
**not** proved end to end by forcing a real smoke failure: the CLI packs the actual workspace
packages, which needs a built `dist/` and a full install, and there is no test-only hook to
fail the smoke without adding one. So the claim proved is "the single gate that decides refuses
without a passing smoke, and the CLI consults that gate", not "a real failed smoke was observed
to leave no manifest."

---

### RI-B6 — release-mode SBOM accepted empty or malformed evidence — **repaired here**

Genuinely unrepaired. The release-install path parsed, annotated, and wrote npm's output with
none of the checks the workspace path applies.

**Failing first** (fake npm on PATH returning `{}` and then non-JSON):

```text
✖ release-mode SBOM refuses an empty npm response instead of writing it as evidence
  AssertionError: Wrote 0-component SBOM for release-artifacts to /tmp/apex-sbom-release-empty-aVIZjo/out/sbom-release-artifacts.cyclonedx.json
    actual: 0
    expected: 1
✖ release-mode SBOM refuses malformed npm output instead of writing it as evidence
  AssertionError: The input did not match the regular expression /did not produce valid JSON/. Input:
  `Unexpected token 'o', "not json at all" is not valid JSON\n`
```

That first line is the finding reproduced exactly: exit 0, and a zero-component SBOM written as
release evidence.

**What changed.** Extracted `parseSbomEvidence(output, label)` — JSON parse with a named error,
an object check, and the existing `components.length <= 1` non-empty rule — and applied it to
both the workspace path and the release-install path.

**Passing after:**

```text
✔ release-mode SBOM refuses an empty npm response instead of writing it as evidence (1692.302295ms)
✔ release-mode SBOM refuses malformed npm output instead of writing it as evidence (1220.434761ms)
✔ release-mode SBOM writes a real component set and annotates it with the retained artifact identity (873.489038ms)
```

---

### RI-B7 — standalone archive set not enforced — **pre-existing repair, already covered**

`REQUIRED_STANDALONE_ARTIFACTS` (six names) is enforced on write and on read, the reader
rejects a short or duplicated set, and the final job asserts the manifest's `releaseIdentity`
against `${GITHUB_SHA}` / `${GITHUB_REPOSITORY}` / the workflow path / `${GITHUB_REF}`. Covered
by `manifest writer and reader reject anything but exactly the two owned packages and six
standalone archives`. No new failing-first evidence was produced for this row; the RI-B8 layout
test below now also executes that final-job identity check for real against a materialised
download, which is the first time that assertion has actually been run rather than pattern-matched.

---

### RI-B8 — mixed upload roots break the standalone publication job — **repaired here**

Genuinely broken, and half-fixed in a way that would still have failed: the manifest paths in
the final job had been updated to the nested layout while `SHA256SUMS`, `artifact-identity.sha256`,
and the `gh release create` globs were still flat.

**What changed.** Added an offline **path-layout** test (not another regex): it materialises
what the publish job leaves in `${RUNNER_TEMP}`, replays the workflow's own pure `cp`/`mv`
staging steps, applies `actions/upload-artifact`'s least-common-ancestor rooting to the real
`path:` block, copies the matched files into a `release-assets/` tree, and then runs the final
job's **actual** shell block against it with `gh` stubbed — so `test -s`, `sha256sum -c`, and
the inline `node -e` manifest/identity validator all execute for real. It then asserts the six
archive paths and `SHA256SUMS` actually reached `gh` (an unexpanded glob would otherwise upload
a partial release silently).

The workflow now stages `release-artifacts.json` into `${RUNNER_TEMP}/binaries/` before upload,
so every uploaded path shares one root and the download is flat; the final job reads
`release-assets/release-artifacts.json` and `join("release-assets", x.filename)`.

**Failing first** (workflow reverted to the mixed-root upload):

```text
✖ the standalone artifact survives upload/download with the layout the release job actually reads
  AssertionError: final release job failed against the real downloaded layout (upload root /tmp/apex-release-layout-d2bxvS/runner-temp):
  release-assets/binaries/SHA256SUMS
  release-assets/binaries/apex-code-darwin-arm64.tar.gz
  release-assets/binaries/apex-code-darwin-x64.tar.gz
  release-assets/binaries/apex-code-linux-arm64.tar.gz
  release-assets/binaries/apex-code-linux-x64.tar.gz
  release-assets/binaries/apex-code-windows-arm64.zip
  release-assets/binaries/apex-code-windows-x64.zip
  release-assets/binaries/artifact-identity.sha256
  release-assets/packed-product-surface/release-artifacts.json
  ---stdout---
  ---stderr---
    actual: 1
    expected: 0
```

**Passing after:**

```text
✔ the standalone artifact survives upload/download with the layout the release job actually reads (982.856945ms)
```

**Deliberately narrowed.** The test models `actions/upload-artifact`'s documented LCA rule; it
does not run the action. If that rule ever changes, the model goes stale — but the model is now
explicit and in one function instead of implicit in a regex.

---

### RI-B9 — license evidence omitted nested production dependencies — **pre-existing repair, mutation-proved (tests added here)**

`collectLicenseEntries()` in the tree already walked nested `node_modules` with a realpath
`visited` set, but nothing tested it. Added two fixture tests: a tree with a non-hoistable
nested version, a nested scoped package, and a two-level-deep transitive dependency; and a
de-duplication case where the same name@version is reachable through two parents.

**Failing first** (`collectLicenseEntries` reverted to the audited direct-children-only loop):

```text
✖ license closure walks nested node_modules, not just hoisted top-level packages
    actual: undefined
    expected: { name: 'conflicting-dep', version: '1.0.0', license: 'ISC' }
✖ license closure de-duplicates the same name and version reached through two nesting paths
    actual: 0
    expected: 1
```

**Passing after** (implementation restored — `generate-license-report.mjs` is byte-identical to
how this owner found it):

```text
✔ license closure walks nested node_modules, not just hoisted top-level packages (196.89287ms)
✔ license closure de-duplicates the same name and version reached through two nesting paths (171.287377ms)
```

**Deliberately narrowed.** This proves the *installed tree* is walked completely. It does not
prove the walk equals the production closure of the lockfile: the report still reads whatever
`--node-modules` points at (the release points it at the packed smoke install, created with
`--omit=dev`), rather than deriving the closure from a validated production dependency tree.
The workflow's phrase "complete transitive production dependency license closure" is now true
of that installed tree, and no stronger.

---

### RI-B10 — registry `gitHead` is absent for a packed-tarball publish — **repaired here**

**Premise verified twice, offline.**

1. Source: `@npmcli/package-json/lib/index.js` lists `gitHead` in `prepareSteps` only, and
   `lib/commands/publish.js:281-296` runs `pkg.prepare()` **only** when `spec.type === 'directory'`;
   a tarball spec goes through `pacote.manifest(spec)`, which reads the manifest out of the
   tarball. `grep -rn gitHead` across `libnpmpublish` and `pacote` returns nothing.
2. Live: `npm pack --json --ignore-scripts` on a package inside a real git repository (HEAD
   `874f199…`) produced `package/package.json` =
   `{ "name": "apex-githead-probe", "version": "1.0.0", "license": "MIT" }` — no `gitHead`.

**Decision taken (one coherent answer).** Drop the registry `gitHead` *requirement*. The
directory-side commit is already recorded and enforced in the release artifact record
(`expectedGitCommit` / `releaseIdentity`, checked at the manifest reader, the publisher, and the
final GitHub Release job against `${GITHUB_SHA}`), and the commit binding that the registry can
actually attest is the **signed** provenance statement's resolved `gitCommit`, which
`checkVerifiedProvenance()` already enforces. A `gitHead` that *is* present must still agree, so
a directory-published package is not silently downgraded.

**Failing first:**

```text
✖ checkPublishedMetadata accepts absent gitHead, because a packed-tarball publish never records one
  AssertionError: Expected values to be strictly deep-equal:
  + actual - expected
  + [
  +   'registry metadata has no gitHead recorded for this version'
  + ]
  - []
```

**Passing after:**

```text
✔ checkPublishedMetadata accepts absent gitHead, because a packed-tarball publish never records one (0.504168ms)
✔ checkPublishedMetadata still rejects a gitHead that is present but disagrees (0.511148ms)
✔ a real packed tarball built inside a git repository carries no gitHead (4253.049168ms)
```

The third is the live fixture: it `git init`s, commits, packs for real, and asserts the packed
manifest has no `gitHead`, so the premise cannot rot silently. The offline CLI fixtures now also
serve registry metadata with **no** `gitHead`, matching what a real Apex release will produce.

**Docs updated to match.** ADR 0018 gains a "Where the commit binding lives" paragraph and its
post-publication sentence no longer names registry `gitHead`; the runbook's detection list and
step 3 now direct the responder to the signed statement (with the `npm audit signatures
--json --include-attestations` command) and state plainly that a missing `gitHead` is expected
and proves nothing; the spec's release-identity row records the payload location, the
smoke-gated record, and the `gitHead` disposition.

**Deliberately narrowed.** No release has been published with this code, so "the registry copy
really has no `gitHead`" is proved for the *pack* step and by npm's own publish source, not by
an observed registry document for an Apex package.

---

### Files changed by this owner

```text
.github/workflows/release.yml
docs/adr/0018-apex-only-release-version-authority.md
docs/release-integrity-runbook.md
docs/specs/2026-09-05-security-boundary-remediation.md      (release-identity row only)
scripts/apex/fixtures/npm-attestation-bundles.mjs           (new)
scripts/apex/generate-license-report.test.mjs
scripts/apex/generate-sbom.mjs
scripts/apex/generate-sbom.test.mjs
scripts/apex/packed-product-surface.mjs
scripts/apex/packed-product-surface.test.mjs
scripts/apex/publish-release-artifact.test.mjs
scripts/apex/verify-published-release.mjs
scripts/apex/verify-published-release.test.mjs
scripts/release-workflow.test.mjs
.apex-code/security-remediation/ri-verifier.md              (this section)
```

`scripts/apex/generate-license-report.mjs` was reverted to byte-identical state after the
RI-B9 mutation probe and is **not** a change by this owner. Nothing under `packages/` was
edited by this owner.

### Gates

`node --test scripts/apex/*.test.mjs scripts/release-workflow.test.mjs` — exit 0:

```text
ℹ tests 131
ℹ suites 0
ℹ pass 127
ℹ fail 0
ℹ cancelled 0
ℹ skipped 4
ℹ todo 0
ℹ duration_ms 14454.36982
```

The four skips are the three real-network `@earendil-works/pi-ai` cases
(`APEX_RELEASE_REGISTRY_TEST=1`) and the real packed smoke (`APEX_PACKED_SMOKE_TEST=1`). None
were run: all three require network or a built `dist/` plus a full install.

`npx tsgo --noEmit` — exit 0, no output.

`npm run check` — exit 0. Full chain green: biome, `check:docs` ("Documentation lifecycle
validation passed."), `check:pinned-deps`, `check:ts-imports`, `check:scrubber`,
`check:shrinkwrap` (up to date), `check:install-lock:coding-agent` (up to date), `tsgo --noEmit`,
`check:browser-smoke`. One pre-existing non-blocking info remains in
`packages/coding-agent/test/tools/edit-diagnostics.test.ts:250` (`lint/style/useTemplate`,
unsafe fix, not applied, not this owner's file).

**One thing the reviewer must know about that gate.** `npm run check` starts with
`biome check --write --error-on-warnings .`, so it **rewrites files across the whole
repository** — its own output line was `Checked 1354 files in 44s. Fixed 10 files.` A second
owner was actively editing `packages/coding-agent/` during this session (HEAD advanced to
`f0c1368ca` mid-run, and new untracked files appeared), so this owner cannot attribute those ten
fixes and cannot rule out that the repo's own gate reformatted another owner's in-flight file.
A read-only `biome check .` run afterwards now reports a formatting difference in
`packages/coding-agent/src/core/agent-session.ts` from that owner's newer edits; `npm run check`
was deliberately **not** re-run, because doing so would rewrite their working file. Reviewer
action: inspect `git diff -- packages/` for whitespace-only hunks before committing.

### Findings this owner could not fully close

- **RI-B1** — the cryptographic half is unproved offline. Nothing here verifies a Sigstore
  signature; the suite proves field selection, decoding, and expectation enforcement only.
  Missing evidence: one real tagged release whose `npm audit signatures --json
  --include-attestations` output is retained and replayed.
- **RI-B2** — "a real npm 11.19.0 signed result passes" is still unproved. Missing evidence:
  the same real release.
- **RI-B3** — no macOS runner was available. The gate's *presence and ordering* are proved; the
  macOS smoke's *success* is not.
- **RI-B5** — the "real smoke failure leaves no manifest" path is proved at the gate function,
  not end to end through a forced smoke failure.
- **RI-B9** — the closure is proved complete over the installed tree, not derived from a
  validated production dependency tree or lockfile.
- **RI-B10** — proved for `npm pack` and from npm's publish source; not confirmed against a
  published Apex package's registry document.
- **Process blocker** — `docs/plans/2026-09-05-plan-release-integrity.md` was **not** touched.
  It is outside this owner's file boundary for this task, and RI.1–RI.5 still read `not started`
  with no commit SHAs. That row of the verification report remains open and must be closed by
  whoever commits this work, with real SHAs verified by `git cat-file -t`.

No commit, stage, rebase, reset, clean, branch switch, publish, deploy, force-push, registry
call, or prohibited-source access occurred while producing this section.
