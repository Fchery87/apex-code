**Status:** In progress

# Standalone Release Installer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish checksum-verified Apex Code standalone archives and install them per-user from POSIX shells, PowerShell, and Git Bash.

**Architecture:** Preserve `scripts/build-binaries.sh` as the archive builder. Add a deterministic checksum-preparation seam, release the output only after the npm and macOS gates succeed, and keep the two small installers as platform adapters over the same asset contract.

**Tech Stack:** Node.js ESM scripts, Bash, PowerShell, GitHub Actions, GitHub Releases, `node:test`.

---

| Task | Status | Commit |
| --- | --- | --- |
| 1. Define the artifact contract and release-order tests | Not started | — |
| 2. Implement checksum preparation and verified POSIX installer | Not started | — |
| 3. Implement verified PowerShell installer and user PATH registration | Not started | — |
| 4. Wire binary artifacts into the release workflow and update install documentation | Not started | — |
| 5. Run release-scope validation and publish the branch | Not started | — |

## Task 1: Define the artifact contract and release-order tests

**Files:**
- Create: `scripts/apex/prepare-binary-release.test.mjs`
- Modify: `scripts/release-workflow.test.mjs`
- Modify: `docs/specs/2026-08-25-standalone-release-installer.md`

1. Write tests for the six exact archive names, rejected extra/missing assets, deterministic
   SHA-256 manifest shape, and the separate least-privilege GitHub Release job.
2. Run `node --test scripts/apex/prepare-binary-release.test.mjs scripts/release-workflow.test.mjs`.
   Confirm failures state that the producer/job does not yet exist.
3. Record the finalized artifact names and release order in the spec.

## Task 2: Implement checksum preparation and verified POSIX installer

**Files:**
- Create: `scripts/apex/prepare-binary-release.mjs`
- Create: `install.sh`
- Modify: `scripts/apex/prepare-binary-release.test.mjs`

1. Implement a pure Node script that validates and hashes only the expected release archives.
2. Implement `install.sh` in strict mode, including tag/platform resolution, hash validation,
   safe temporary extraction, atomic replacement, and Unix/Git-Bash PATH handling.
3. Run the new script tests and `bash -n install.sh`.

## Task 3: Implement verified PowerShell installer and user PATH registration

**Files:**
- Create: `install.ps1`
- Modify: `scripts/apex/prepare-binary-release.test.mjs`

1. Extend the contract test to cover native Windows install directory, `Get-FileHash`, archive
   expansion after verification, and idempotent user PATH update.
2. Run it and confirm the expected failure before the installer exists.
3. Implement the PowerShell installer with `Set-StrictMode`, error-stop behavior, a temporary
   directory, replacement only after successful verification, and a no-duplicate PATH update.
4. Run the focused tests and available static syntax validation.

## Task 4: Wire binary artifacts into the release workflow and update install documentation

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/release-workflow.test.mjs`
- Modify: `README.md`
- Modify: `docs/user-guide.md`
- Modify: `docs/release-integrity-runbook.md`
- Modify: `docs/release-governance-checklist.md`

1. Extend workflow tests first: archive build precedes npm publication; the release job waits
   for both npm provenance and macOS verification; `contents: write` is isolated to that job.
2. Run the workflow tests and confirm failure.
3. Build, checksum, smoke-test, and preserve archives before npm publication. Add the release
   job that uploads those archives as the version-tagged GitHub Release after both gates pass.
4. Replace the README’s obsolete installer statement with exact POSIX, PowerShell, and Git Bash
   commands. Document trust assumptions and binary-release recovery/governance.
5. Run `node --test scripts/release-workflow.test.mjs scripts/apex/prepare-binary-release.test.mjs`
   and `npm run check:docs`.

## Task 5: Run release-scope validation and publish the branch

**Files:**
- Delete: `docs/plans/2026-08-25-standalone-release-installer.md`
- Modify: `docs/specs/2026-08-25-standalone-release-installer.md`

1. Run the focused tests, shell syntax check, Biome on changed JS/Markdown, and the full
   relevant script suite. Run `npm run typecheck` if it is available; otherwise record the
   project’s equivalent typecheck command and result.
2. Update the spec with any necessary implementation correction; delete this completed plan
   in the final feature commit, as required by `AGENTS.md`.
3. Commit with a focused conventional message and push `feat/release-installer` for review.
