# Phase 6 durable state & daemon plan

**Status:** In progress

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 6.1 Inspect session/auth boundaries and choose SQLite ownership | Done | `f3298fb7e` | Mapped `SessionManager`/JSONL, `AuthStorage`, `ModelRuntime`, and the existing `pi-server`/`pi-client` lease seams. ADR 0006 settles JSONL as session-of-record, a daemon-owned SQLite sidecar, credential exclusion, additive migrations, and `node:sqlite` behind an adapter. |
| 6.2 Define additive SQLite schema and migrations | Done | `db9fe82e8` + `43f449c8e` | Versioned sidecar schema, idempotent reopen, forward-version refusal, explicit non-secret tables, and JSONL readability without a sidecar. `test/durable-state/sqlite-store.test.ts`: 4 passing. |
| 6.3 Implement durable command journal and crash recovery | Done | `491a03a48` + `9ec8d3806` + `6e17499c1` + `d23fca7c7` | Durable journal transitions, daemon lifecycle recovery, journal-before-operation, and real child-process `SIGKILL`/restart recovery are covered. |
| 6.4 Implement daemon-local leases and client attach | Done | `491a03a48` + `2ff5b1d32` + `6e17499c1` + `f37820110` | Durable leases support shared observers, exclusive writers, expiry, owner release, daemon admission, and two-client contention with ordered JSONL mutation. |
| 6.5 Add git provenance and recovery diagnostics | Done | `1abb41279` + `b8a0767c8` + `b43ebb47f` | Git/non-Git provenance and structured journal recovery diagnostics are exposed at daemon startup and covered by durable-state tests. |
| 6.6 Run phase verification and close the plan | Done | `baf5e5302` | Phase-specific durable-state tests: 13/13 passing; `npx tsgo --noEmit` passing. Clean no-space Node 22 `npm ci`, `npm run build`, and `npm run check` passed. Full `npm test` reached 2290 passing / 4 failing; all four failures were pre-existing environment-sensitive tests and each passed when run narrowly. |

## Order changes

None.

## Shared implementation rules

- Test public boundaries with scratch session directories; never write test state into the repository.
- Run the narrowest test first, then typecheck, then the full suite at the implementation slice boundary.
- Do not persist credentials or tokens in SQLite, JSONL, config, or tracked artifacts.
- Preserve additive session compatibility until the Phase 6 ADR settles migration policy.
