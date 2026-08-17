# ADR 0017 — Downloaded tool artifact integrity

**Status:** Accepted · **Date:** 2026-08-16

## Decision

Auto-downloaded executable tools (`fd`, `rg`) are installed only from reviewed, pinned
release metadata — an exact version, exact per-platform/architecture asset URL, and an
expected SHA-256 digest and byte size, all recorded in source and updated only through a
reviewed code change. The runtime never resolves "latest" from the GitHub API before
installing an executable.

Installation is bounded, verified, and atomic:

- **Bounded download.** The declared content length and the actually received byte count
  are both checked against a per-artifact maximum (four times the reviewed expected size);
  a response that exceeds it aborts the download rather than writing an unbounded stream to
  disk.
- **Digest verification.** The downloaded archive's SHA-256 is computed and compared to the
  pinned digest before any extraction happens. A mismatch fails with no executable promoted.
- **Quarantine extraction.** The archive is extracted into a per-install temporary directory
  colocated with the final tools directory (same filesystem, so promotion can be an atomic
  rename), never directly into the live tools directory.
- **Path containment.** The binary located inside the quarantine directory is resolved and
  checked to still be a descendant of that quarantine directory before promotion, rejecting
  an archive entry that resolves outside it.
- **Atomic promotion.** Only after digest and containment checks pass does the binary move
  into the live tools directory via a same-filesystem rename; the quarantine directory is
  always removed afterward, success or failure.

A platform/architecture combination with no reviewed pin (for example, no upstream Windows
arm64 `ripgrep` release exists) fails closed with a clear error rather than constructing a
URL that does not resolve.

Pinned metadata was established by downloading each covered artifact, computing its SHA-256
locally, and cross-checking that value against the upstream-published digest (`ripgrep`'s own
`.sha256` release sidecars, and GitHub's own per-asset `digest` field for both projects) —
not invented, and not taken from a single unverified source.

## Consequences

- A compromised or rotated upstream release asset is rejected rather than silently installed,
  at the cost of the runtime no longer picking up a new upstream release automatically; a
  version bump requires a reviewed source change to the pin table.
- The existing `fd` macOS x86_64 pin (10.3.0, upstream's last release shipping an Intel macOS
  binary) is preserved unchanged inside the new pin table rather than special-cased separately.
- Offline mode and system-`PATH` fallback behavior are unchanged; this only affects the
  managed-download path.
- Windows and other unpinned combinations fail with a diagnostic instead of a broken download
  URL; that is a correctness fix, not a new restriction, since the prior "latest" lookup could
  already 404 on those combinations without a clear cause.

## Rejected alternatives

**Keep resolving "latest" but add digest pinning per release as it ships.** Rejected because
the digest would still be fetched over the network at install time from the same mutable
"latest" pointer, so a compromised release could ship both a malicious binary and a matching
malicious digest together.

**Verify digest after promotion (best-effort cleanup on mismatch).** Rejected because a race
or crash between promotion and cleanup could leave an unverified executable live in the tools
directory; verifying before promotion means the live directory only ever contains something
that already passed.

**Full custom archive-format parsing to validate every entry path before extraction.**
Deferred as disproportionate to two small, well-known tool archives; quarantine plus a
post-extraction containment check on the one binary the code actually uses gives the same
practical guarantee without reimplementing tar/zip parsing in this repository.
