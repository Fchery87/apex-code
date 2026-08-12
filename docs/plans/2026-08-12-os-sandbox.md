# Phase 2b OS sandbox

**Status:** Active

Implement the OS sandbox as a whole-Apex-process boundary, not a bash wrapper. This
plan implements ADR 0005 and `docs/specs/2026-08-12-os-sandbox.md` in dependency
order; each task must be verified before it is marked done.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 2b.1 Add Apex sandbox domain types, configuration validation, bounded violations, and fail-closed preflight tests | In progress | — | New unit tests fail first, then pass |
| 2b.2 Implement Linux supervisor/backend and process-child launch sentinel | Not started | — | Fake-backend launch/lifecycle tests pass |
| 2b.3 Add Linux OS integration fixtures for workspace write, outside-write refusal, blocked network, and grandchild containment | Not started | — | Real commands pass on provisioned Linux; explicit skipped reason otherwise |
| 2b.4 Wire CLI diagnostics/lifecycle and package distributable dependency | Not started | — | CLI routing tests, build, install-lock check |
| 2b.5 Add macOS backend only after native CI proof; document unsupported Windows | Not started | — | macOS integration tests pass |
| 2b.6 Full verification and documentation closure | Not started | — | Focused suites, typecheck, build, full test; plan deleted |

## Order changes

The inherited optional sandbox extension is not promoted as the implementation path:
it wraps only bash and would leave native tools, extensions, and in-process execution
outside the claimed boundary. The initial concrete backend is Linux because its
Bubblewrap behavior is testable in the current development environment; macOS follows
only with native evidence.
