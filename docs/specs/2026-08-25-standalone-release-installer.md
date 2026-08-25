# Spec: Standalone release installer

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Status | `Active` |
| Created | 2026-08-25 |
| Last updated | 2026-08-25 |
| Roadmap phase | `12 — Production graduation and release integrity` |
| Governing decisions | ADR 0005, ADR 0014, ADR 0018 |
| Compatibility posture | npm remains supported and unchanged; the standalone channel adds an optional, per-user installation path. |

## Problem

Apex Code can already compile standalone archives for macOS, Linux, and Windows, but
the release workflow publishes only npm packages. New users must install Node.js and a
package manager even when they only want the CLI. Windows users additionally need a
single installation that works after reopening PowerShell, Command Prompt, Windows
Terminal, or Git Bash.

## Goals

- Publish six checked archives on each successful version tag: macOS and Linux x64/ARM64,
  plus Windows x64/ARM64.
- Provide a POSIX installer for macOS, Linux, and Git Bash, and a PowerShell installer for
  native Windows terminals.
- Verify every downloaded archive against a release-local `SHA256SUMS` manifest before it
  is extracted or installed.
- Install without elevation: `~/.local/bin` on Unix and `%LOCALAPPDATA%\\Apex Code\\bin`
  on Windows.
- Add the chosen per-user directory to the user PATH idempotently, then state that a new
  terminal session is required.
- Keep GitHub Release creation behind all existing npm publication/provenance gates and the
  macOS registry-install verification.
- Keep `apex-code@next` as an equal supported distribution channel.

## Non-goals

- Windows sandbox enforcement; it remains out of scope under ADR 0005.
- Machine-wide installs, administrator elevation, package-manager integrations, or automatic
  updates of a standalone installation.
- Code signing or an independent signature service. Checksums detect corrupted downloads;
  release access remains protected by the repository's GitHub release authority and the
  release-governance checklist.

## Architecture

`scripts/build-binaries.sh` remains the sole archive producer. A new
`scripts/apex/prepare-binary-release.mjs` accepts the build output directory, validates the
six exact archive names, and writes a deterministic `SHA256SUMS` file beside them. It does
not build, publish, or select platforms.

The `publish` job builds and tests these archives before publishing either npm package, then
uploads them as an internal workflow artifact. A small `publish-binaries` job depends on both
the successful npm job and macOS clean-install verification. It is the only job granted
`contents: write`; it downloads the verified artifact and creates the matching GitHub Release.

`install.sh` resolves either an explicit `APEX_CODE_INSTALL_VERSION` or the latest GitHub
Release tag, maps `Darwin`/`Linux` and architecture to an archive name, and treats
MINGW/MSYS/CYGWIN as Windows. For Git Bash it installs the Windows archive into the same
`LOCALAPPDATA` location used by PowerShell. `install.ps1` has the native Windows equivalent.
Both download the manifest first, require the expected single filename/hash entry, verify the
archive in a temporary directory, extract only after verification, atomically replace the
installation directory, and make the user PATH change idempotently.

### Installer contract

```text
release URL  -> resolve tag -> SHA256SUMS + one exact platform archive
                         -> verify digest -> extract into temp -> replace user install directory
                         -> add directory to user PATH if absent -> print next-step instruction
```

The archive names are the public contract:

| Runtime | Asset |
| --- | --- |
| macOS arm64 | `apex-code-darwin-arm64.tar.gz` |
| macOS x64 | `apex-code-darwin-x64.tar.gz` |
| Linux arm64 | `apex-code-linux-arm64.tar.gz` |
| Linux x64 | `apex-code-linux-x64.tar.gz` |
| Windows arm64 | `apex-code-windows-arm64.zip` |
| Windows x64 | `apex-code-windows-x64.zip` |

## Security and failure behavior

- The installer rejects an invalid version, unsupported platform, missing or duplicate hash,
  unavailable hash utility, or hash mismatch before extraction.
- Temporary downloads are created with the platform temporary-directory facility and removed
  on exit. An unsuccessful download never replaces an existing installation.
- No secrets, credentials, elevation, or repository-local configuration are involved.
- The workflow preserves least privilege: npm Trusted Publishing remains in `publish`; only
  `publish-binaries` receives `contents: write` to create a release from already-verified data.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| Statement that Apex Code has no shell installer or standalone-binary update channel | documentation | replaced with the documented GitHub Release installer channel |
| npm/Node as the only installation path | documentation | replaced with npm plus standalone archive installation |
| Unpublished standalone archive build output | release behavior | replaced with verified GitHub Release assets |
| Nothing else | behavior | retained; npm release provenance and platform support posture remain unchanged |

## Verification

- Script tests prove exact archive validation, deterministic checksum output, release workflow
  ordering/permissions, and installer platform/PATH/integrity contracts.
- A Linux build job executes the local-platform standalone binary's `--version` check before
  npm publication.
- The existing npm package, packed-artifact, provenance, and macOS registry-install gates
  continue to run unchanged.
- The first tag after merge is manually smoke-tested with one POSIX command, PowerShell, and
  Git Bash against the resulting GitHub Release.
