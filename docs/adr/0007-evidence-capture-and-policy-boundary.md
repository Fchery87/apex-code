# ADR 0007 — Evidence capture in core; policy remains a bundled extension

**Status:** Accepted · **Date:** 2026-08-16

## Decision

Evidence capture belongs in Apex Code core, at the tool execution boundary. A tool
must record facts it directly observes—such as a subprocess exit code, the exact
normalized argv, a patch hash, or a written byte count—rather than asking an
extension to reconstruct those facts from rendered tool output or assistant text.

The canonical `ToolContract.evidence.capture()` remains the single declaration of
what a tool can emit. A shared execution wrapper invokes that capture function after
a tool returns, passes the resulting records to an injected `EvidenceSink`, and
never treats evidence as an authorization decision. Failed tool calls emit evidence
when the tool has observed a meaningful attempt; capture failures never convert a
successful tool call into a failed call and are reported through diagnostics.

The session of record stores a bounded, additive evidence entry containing the
structured record and references to any larger artifact. Full command output,
secret values, and file contents do not enter the evidence entry by default. Large
payloads live under the session-owned `.apex-code/` artifact root and are referred
to by a relative artifact identifier. JSONL remains authoritative; the SQLite
sidecar may index evidence later but is not required to read it.

The SpecEngine, gate evaluation, and governance policy remain an optional bundled
extension. Core emits evidence without deciding whether a claim satisfies a policy.
The policy extension consumes evidence through a public read boundary and may be
switched off without disabling capture.

## Evidence boundary

Every record has a stable record ID, kind, session ID, tool name, timestamp, and a
bounded facts object. Tool-specific facts are typed at the producer boundary and
must exclude credentials, access tokens, refresh tokens, and raw file contents.
Artifact references are opaque relative paths beneath the session artifact root;
callers cannot supply an arbitrary filesystem path as an evidence reference.

The initial first-party facts are:

- `bash`: normalized executable/argv, cwd, exit code, signal/timeout status, and
  stdout/stderr artifact references when output exceeds the bounded inline limit;
- `edit`: affected paths and a hash of the generated patch;
- `write`: affected path, byte count, and content hash;
- `test`: normalized executable/argv, cwd, exit code, signal/timeout status, and a
  result artifact reference when output is externalized.

## Why this shape

Rendered tool results are presentation data: truncation, ANSI formatting, compaction,
and extensions can change them. They are not a trustworthy source for verification.
The tool execution path has the authoritative facts and can emit them before those
facts are transformed for the model or UI.

Storing complete output inline would make sessions grow without bound and would risk
secrets. Storing only an in-memory ledger would lose evidence on restart. Bounded
records plus session-owned artifact references preserve inspectability without making
JSONL or the sidecar a secret dump.

Keeping policy separate prevents a policy bug or disabled governance extension from
silently disabling the evidence needed to diagnose it. It also keeps core useful for
callers that want audit facts but have different verification rules.

## Consequences

- Tool wrappers need an injected sink and a source/session identity.
- Existing tools can retain their declared evidence kinds while enriching their
  execution details incrementally.
- Evidence entries add a discriminated, additive session type and require a reader
  that tolerates unknown future evidence kinds.
- Tests must execute tools in scratch directories and assert the emitted facts at the
  public sink boundary.
- The Phase 7 false-positive measurement must use the existing `gatedFailures()`
  baseline; capture itself must not silently become a gate.
