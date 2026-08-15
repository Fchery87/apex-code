# Spec: Evidence & verification

**Status:** Active — ADR 0007 accepted

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Created | 2026-08-16 |
| Last updated | 2026-08-16 |
| Roadmap phase | `7 — Evidence & verification` |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility: evidence is additive, bounded, and optional to consume; existing JSONL sessions remain readable without evidence entries. |

## Deletion inventory

No existing source or document is made obsolete. The Phase 6 plan was deleted on completion; its durable-state decisions remain in ADR 0006 and the Phase 6 spec. Existing tool contracts remain the declaration surface and are extended only through additive evidence facts.

## Executive summary

Phase 7 makes verification facts trustworthy by capturing them where the work happens. Core tools will emit bounded structured evidence to an injected sink, while a separate optional policy extension may interpret that evidence. Session JSONL stores durable evidence records and references larger scratch artifacts without embedding secrets or unbounded output.

## Context and motivation

- `docs/roadmap.md` Phase 7 requires source-level evidence for bash, edit, write, and test.
- ADR 0010 and `packages/coding-agent/src/core/tools/contract.ts` already require every tool to declare an `EvidenceSpec`, but no shared ledger or durable sink currently consumes it.
- ADR 0006 keeps JSONL as the session of record and permits additive session entries; SQLite is a derived operational sidecar, not a transcript replacement.
- `docs/architecture/contracts.md` §1.4 defines evidence capture as a tool-owned operation and records Phase 7 as its consumer.

## Current state

`EvidenceRecord` is currently a structurally open `{ kind, ... }` interface. First-party tools declare evidence kinds and capture functions, but capture is not wired to a shared sink. Bash currently captures only the requested command, edit/write capture only the requested path, and no durable evidence entry is appended to a session. There is no first-party test-runner evidence boundary yet. Policy references in the roadmap describe a bundled extension; this phase exposes an optional read-only policy adapter, not a core policy engine. A repository-wide tracked-file audit found no `gatedFailures()` implementation or calibration corpus, so a numeric false-positive threshold cannot be honestly measured or invented.

## The problem

A post-hoc observer sees rendered results, not authoritative execution facts. Bash truncation can hide output and currently does not preserve the exit status in evidence; edit/write records lack patch/content hashes; and without a durable sink evidence disappears on restart. Conversely, copying full output or file contents into a ledger creates unbounded growth and a secret-retention risk.

## Goals

- [ ] A shared public execution boundary invokes declared evidence capture and emits records to an injected sink.
- [ ] Bash evidence includes normalized argv, exit status, cwd, and termination details.
- [ ] Edit/write evidence includes affected paths and cryptographic hashes without storing file contents.
- [ ] A normalized test execution boundary emits test evidence, including failure status.
- [ ] Evidence is durably represented in additive JSONL entries and remains available across reload and compaction.
- [ ] Evidence references are bounded and session-owned; secrets and raw contents are excluded.
- [ ] The existing governance/policy layer can consume evidence without being required for capture.
- [ ] A repository audit records whether a `gatedFailures()` corpus exists; no threshold is invented when it does not.

## Non-goals

- Replacing JSONL with SQLite.
- Building a general policy engine in core.
- Automatically proving a natural-language claim from evidence.
- Persisting complete command output, file contents, or credentials in the session ledger.
- Adding evidence to foreign tools that do not provide a contract.

## Design outline

The implementation proceeds from a sink interface to first-party producers. The sink
assigns record identity, validates the session-owned artifact boundary, bounds inline
facts, and appends an evidence entry. Tool-specific execution details are captured
before result rendering. A read-only evidence query boundary serves future policy
extensions and diagnostic surfaces.

Evidence emitted by a failed call is marked with its observed failure state. If a call
fails before the producer observes enough facts to create a record, the sink records a
structured capture diagnostic rather than fabricating success or failure evidence.

## Verification map

| Requirement | Public test |
| --- | --- |
| Capture is wired once | Tool execution through the shared wrapper with a recording sink |
| Bash facts are source-level | Scratch command with non-zero exit and timeout cases |
| Edit/write facts are bounded | Real scratch mutations; compare hashes and assert no contents |
| Test facts are normalized | Fixture executable and argument normalization tests |
| Durability | Append/reload/compaction session tests |
| Secret boundary | Sink and artifact tests with token-like inputs |
| Policy separation | Capture works with no policy extension; policy consumes read-only records |
| False-positive baseline | Repository audit records the absent `gatedFailures()` corpus; no unmeasured threshold is claimed |

## Rollout and deletion inventory

No existing source is deleted. The implementation may supersede only the currently
unused, parameter-only evidence capture payloads by enriching their facts while
preserving their declared kinds and contract API.
