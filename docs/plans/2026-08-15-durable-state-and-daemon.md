# Phase 6 durable state & daemon plan

**Status:** In progress

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 6.1 Inspect session/auth boundaries and choose SQLite ownership | Done | `f3298fb7e` | Mapped `SessionManager`/JSONL, `AuthStorage`, `ModelRuntime`, and the existing `pi-server`/`pi-client` lease seams. ADR 0006 settles JSONL as session-of-record, a daemon-owned SQLite sidecar, credential exclusion, additive migrations, and `node:sqlite` behind an adapter. |
| 6.2 Define additive SQLite schema and migrations | Done | `db9fe82e8` + `43f449c8e` | Versioned sidecar schema, idempotent reopen, forward-version refusal, explicit non-secret tables, and JSONL readability without a sidecar. `test/durable-state/sqlite-store.test.ts`: 4 passing. |
| 6.3 Implement durable command journal and crash recovery | Not started | — | SIGKILL/restart integration test with explicit interrupted state. |
| 6.4 Implement daemon-local leases and client attach | Not started | — | Two-client contention test with valid ordered JSONL. |
| 6.5 Add git provenance and recovery diagnostics | Not started | — | Git/non-Git fixture tests and structured diagnostics. |
| 6.6 Run phase verification and close the plan | Not started | — | Full required validation; delete this plan on completion. |

## Order changes

None.

## Shared implementation rules

- Test public boundaries with scratch session directories; never write test state into the repository.
- Run the narrowest test first, then typecheck, then the full suite at the implementation slice boundary.
- Do not persist credentials or tokens in SQLite, JSONL, config, or tracked artifacts.
- Preserve additive session compatibility until the Phase 6 ADR settles migration policy.
