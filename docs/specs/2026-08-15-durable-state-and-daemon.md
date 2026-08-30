# Spec: Durable state & daemon

**Status:** Landed


## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Created | 2026-08-15 |
| Roadmap phase | `6 — Durable state & daemon` |
| Compatibility posture | Additive persistence and transport; JSONL remains the session of record |

## Deletion inventory

This phase makes no existing document obsolete. The Phase 5 plan was deleted when Phase 5 closed; its durable decisions remain in the Phase 5 spec and ADR 0008.

## Decision record

ADR [0006](../adr/0006-session-format-and-durable-state.md) settles JSONL ownership, the SQLite sidecar boundary, credential exclusion, and additive migration policy.

## Objective

Survive daemon crashes and support multiple clients attached to one session without corrupting session state.

## Scope and invariants

1. **SQLite sidecar, not session replacement.** Store auth metadata, usage aggregates, model-performance samples, cache indexes, command journals, and daemon snapshots in SQLite. JSONL remains authoritative for the session tree and remains readable without the daemon.
2. **Journal before execution.** Every long-running command receives a durable command record before its process starts. State transitions are monotonic and recoverable after `SIGKILL`; replay is idempotent.
3. **Single writer, lease-guarded clients.** A daemon owns session mutation. Clients acquire renewable leases; stale leases expire, and a second client cannot silently interleave writes.
4. **Crash recovery is explicit.** On startup, the daemon scans unfinished journal records, marks processes whose ownership cannot be proven as interrupted, and exposes recovery state rather than claiming success.
5. **No secret persistence regression.** SQLite may reference credential identities and statuses but never stores API keys or tokens. Existing credential-store/environment rules remain authoritative.
6. **Git provenance is metadata.** Record repository identity and revision in session metadata without making Git availability a prerequisite for ordinary sessions.

## Non-goals

- Replacing JSONL with SQLite.
- Distributed daemons or network authentication beyond the local client boundary.
- Background delegation result durability; Phase 6 may provide the storage seam, but delegation semantics change only through a follow-up decision.
- Inventing a hard performance target before measuring realistic sessions and concurrent clients.

## Exit criterion

A test kills the daemon during a journaled command, restarts it, and observes an explicit recovered/interrupted state with no duplicate completion. Two concurrent clients attach to one session; lease enforcement prevents overlapping mutation and the resulting JSONL remains valid and ordered.

## Deletion inventory

No existing source, schema, or document is made obsolete by this specification; migrations must be additive and preserve existing JSONL readers.
