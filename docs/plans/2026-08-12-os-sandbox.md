# Phase 2b OS sandbox

**Status:** Active

Implement the OS sandbox as a whole-Apex-process boundary, not a bash wrapper. This
plan implements ADR 0005 and `docs/specs/2026-08-12-os-sandbox.md` in dependency
order; each task must be verified before it is marked done.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 2b.1 Add Apex sandbox domain types, configuration validation, bounded violations, and fail-closed preflight tests | Done | `269302eb0` | `test/sandbox/` passed after red module-import failures |
| 2b.2 Implement Linux supervisor/backend and process-child launch sentinel | Done | `79ce14d60` | Fake-backend routing/lifecycle tests pass; public entry launches a separate child entry |
| 2b.3 Add Linux OS integration fixtures for workspace write, outside-write refusal, blocked network, and grandchild containment | Done | `79ce14d60` | Real Bubblewrap child/grandchild write, host-home, and direct TCP-denial tests pass |
| 2b.4 Wire CLI diagnostics/lifecycle and package distributable dependency | Done | `79ce14d60` | CLI routing/fail-closed process tests, typecheck, and package build pass |
| 2b.4a Wire live violation evidence into the production CLI supervisor | Done | `1fd20fb24` | `test/sandbox/cli-supervisor.test.ts` (fake-backend store threading + real-Bubblewrap default-dependency case), full `test/sandbox/` (6 files/20 tests), `test/permissions/gate-universal.test.ts` (19 tests), `npx tsgo --noEmit`, `npm run build` all pass |
| 2b.5 Add macOS backend only after native CI proof; document unsupported Windows | Not started | — | macOS integration tests pass |
| 2b.6 Full verification and documentation closure | Not started | — | Focused suites, typecheck, build, full test; plan deleted |

## Order changes

The inherited optional sandbox extension is not promoted as the implementation path:
it wraps only bash and would leave native tools, extensions, and in-process execution
outside the claimed boundary. The initial concrete backend is Linux because its
Bubblewrap behavior is testable in the current development environment; macOS follows
only with native evidence.

Task 2b.4a was not in the original sequence: it closes a gap surfaced only after 2b.4
landed — `launchSandboxedCli`'s default dependencies never constructed a
`SandboxViolationStore`, so a real CLI run recorded violations only when a test
manually injected one. It is numbered as a suffix of 2b.4 rather than inserted before
2b.5/2b.6, since task numbers are identifiers, not a sequence, and the two prior tasks
keep their recorded SHAs unchanged.

Remaining evidence-wiring work from the same review — DNS/CONNECT handling and the
`network.allowedHosts` config surface (see the 2026-08-12 spec amendment), a
structured supervisor→child diagnostic protocol if the child itself must surface
evidence, and a live-agent (not just direct-command) boundary test — is intentionally
not folded into 2b.4a and remains open.
