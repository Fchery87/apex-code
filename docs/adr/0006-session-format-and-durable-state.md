# ADR 0006 — Session format ownership and durable state

**Status:** Accepted · **Date:** 2026-08-15

## Decision

Apex Code keeps **JSONL as the session of record**. `SessionManager` remains the
owner of the session entry tree, including ordering, `id`/`parentId` relationships,
branch selection, compaction, and compatibility migrations. SQLite is an **additive
sidecar owned by the daemon/state layer**, stored beneath the Apex Code state root,
and is never required to read or render an existing JSONL session.

The sidecar has four responsibilities:

- durable operational state: command journals, recovery markers, and daemon metadata;
- coordination state: leases and writer ownership;
- derived indexes and aggregates: usage, model-performance samples, and cache metadata;
- schema version bookkeeping and migration execution.

It must not contain API keys, OAuth access or refresh tokens, bearer tokens, or a copy
of credential material. Credential identity/status may be referenced by stable provider
or credential identifiers only; `AuthStorage` and its existing file/credential-store
rules remain authoritative.

The first implementation uses Node's built-in `node:sqlite` API, because the supported
runtime is Node >=22.19 and the repository already has no SQLite dependency. The
SQLite adapter is isolated behind a small Apex Code interface so the storage engine can
be replaced if the runtime API is withdrawn or its stability is insufficient before a
release. No consumed upstream package is patched to provide persistence.

## Ownership boundaries

| Concern | Owner | Source of truth |
| --- | --- | --- |
| Session transcript and tree | `SessionManager` | JSONL session file |
| Session-format migrations | `SessionManager` | JSONL version/header |
| Credentials and token resolution | `AuthStorage` / `ModelRuntime` | existing auth storage and environment |
| Command lifecycle and crash recovery | daemon state layer | SQLite command journal |
| Client/session coordination | daemon state layer | SQLite lease records plus live runtime |
| Usage/performance/cache indexes | daemon state layer | SQLite derived records; rebuildable |
| Provider catalog and model definitions | `ModelRuntime` / model files | existing model registry sources |

The daemon may append to a session only through the session service boundary that owns
`SessionManager`; clients never write session JSONL directly. A standalone CLI remains
valid without a daemon and continues to use the existing JSONL path.

## Compatibility and migration

This is a preserving compatibility decision. Existing v1/v2/v3 JSONL sessions remain
openable without SQLite, and a missing or corrupt sidecar does not make the transcript
unreadable. Sidecar migrations are numbered, transactional, and forward-only; a newer
schema refuses to open with an actionable error rather than silently downgrading.

Session-format changes remain additive and discriminated until a later release requires
a versioned migration. Unknown entry types are ignored by context/rendering code where
appropriate, as established in `docs/architecture/contracts.md` §3. A format migration
must preserve the original JSONL as the recoverable source and must be tested against
fixtures from every supported prior version.

## Journal and lease consequences

A command is inserted into the SQLite journal before its process or session mutation
starts. State transitions are monotonic and include enough identity to make replay
idempotent. On startup, unfinished commands are marked `interrupted` unless ownership
and completion can be proven; the daemon never reports an interrupted operation as
successful.

A daemon is the single writer for a live session. Clients acquire renewable leases
through the daemon, and lease loss rejects further mutation. SQLite leases are a
coordination record, not a substitute for the daemon's in-memory runtime ownership;
both checks are required. Shared observation may coexist, but mutating operations need
an exclusive lease.

## Why this shape

Replacing JSONL with SQLite would improve queryability but would discard the existing
append-only tree's inspectability, branch structure, and standalone recovery path.
Putting journals or leases in JSONL would mix operational state with the transcript and
make atomic crash recovery and multi-client coordination harder to reason about.
Keeping the sidecar additive lets Phase 6 add recovery and attachment without making a
running daemon a prerequisite for ordinary session use.

Using a native third-party SQLite binding was rejected for the first slice because it
adds platform-specific install/build risk to a project whose supported Node runtime
already exposes SQLite. Using JSON or lockfiles for the journal was rejected because
there is no transactional state transition or reliable multi-client compare-and-swap.

## Consequences

- Phase 6 owns a small storage adapter and migrations rather than spreading SQLite calls
  through `SessionManager`, `AuthStorage`, and the RPC implementation.
- SQLite data is disposable/rebuildable except for command-journal recovery records and
  lease state; JSONL remains the fallback for transcript recovery.
- Node runtime support becomes a prerequisite for the adapter and must be checked in CI.
- ADR 0006 settles the previously open session-format ownership and migration contract;
  individual Phase 6 tables and entry types still require tests and may be extended
  additively.
