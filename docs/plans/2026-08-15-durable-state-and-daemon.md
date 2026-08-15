# Phase 6 durable state & daemon plan

**Status:** In progress

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 6.1 Inspect session/auth boundaries and choose SQLite ownership | Done | `f3298fb7e` | Mapped `SessionManager`/JSONL, `AuthStorage`, `ModelRuntime`, and the existing `pi-server`/`pi-client` lease seams. ADR 0006 settles JSONL as session-of-record, a daemon-owned SQLite sidecar, credential exclusion, additive migrations, and `node:sqlite` behind an adapter. |
| 6.2 Define additive SQLite schema and migrations | Done | `db9fe82e8` + `43f449c8e` | Versioned sidecar schema, idempotent reopen, forward-version refusal, explicit non-secret tables, and JSONL readability without a sidecar. `test/durable-state/sqlite-store.test.ts`: 4 passing. |
| 6.3 Implement durable command journal and crash recovery | In progress | `491a03a48` + `b8a0767c8` | Journal transitions and recovery primitives are verified. Remaining: integrate them through a daemon lifecycle and prove real SIGKILL/restart recovery. |
| 6.4 Implement daemon-local leases and client attach | In progress | `491a03a48` + `2ff5b1d32` | SQLite lease API now supports concurrent shared observers and exclusive-writer contention. Remaining: daemon/client service integration and two-client ordered JSONL proof. |
| 6.5 Add git provenance and recovery diagnostics | In progress | `1abb41279` + `b8a0767c8` | Git/non-Git provenance utility and recovery diagnostics are covered by durable-state tests. Remaining: daemon startup diagnostics integration. |
| 6.6 Run phase verification and close the plan | In progress | — | Narrow durable-state tests and typecheck are green. Full repository validation and final clean-checkout verification remain. |

## Order changes

None.

## Shared implementation rules

- Test public boundaries with scratch session directories; never write test state into the repository.
- Run the narrowest test first, then typecheck, then the full suite at the implementation slice boundary.
- Do not persist credentials or tokens in SQLite, JSONL, config, or tracked artifacts.
- Preserve additive session compatibility until the Phase 6 ADR settles migration policy.
