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
| 2b.4b Add a live-agent boundary test through the real CLI entry point | Done | `a2fb44ccc` | `test/sandbox/live-agent-boundary.test.ts` (new, 1 test); full `test/sandbox/` (7 files/21 tests); `test/permissions/gate-universal.test.ts` (19 tests); `npx tsgo --noEmit`; `npm run build`; manual positive control (see below) |
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
`network.allowedHosts` config surface (see the 2026-08-12 spec amendment), and a
structured supervisor→child diagnostic protocol if the child itself must surface
evidence — is intentionally not folded into 2b.4a and remains open.

**2b.4b.** Every prior sandbox test drove either a raw hardcoded shell command
directly against the backend (`linux-backend.test.ts`), or CLI startup/routing
without a completed agent turn (`cli-process.test.ts`). None exercised a real agent
loop making real tool calls inside the sandboxed child. `test/sandbox/
live-agent-boundary.test.ts` closes that gap: a test-only extension
(`test/sandbox/fixtures/boundary-extension.ts`) registers a scripted provider via
`pi.registerProvider()` — no real network call — using `fauxProvider`/
`fauxAssistantMessage`/`fauxToolCall` from `@earendil-works/pi-ai/compat` (the same
`registerProvider()` API the shipped `examples/extensions/custom-provider-anthropic/`
example uses for a real provider). It scripts three turns: a `bash` tool call
attempting a write outside the workspace, a native `write` tool call attempting a
write outside the workspace, then a plain closing turn. The real CLI is spawned as a
subprocess (`--print`, `--extension`, `--model boundary-test/scripted`,
`--permission-mode bypassPermissions` — the only mode that lets both calls execute
headlessly instead of blocking at the permission gate, so the OS boundary is what's
actually being tested, not the permission gate). Verified with a **positive
control**: pointing both tool calls at in-workspace paths instead makes both writes
succeed with the expected content, proving the blocked outcome is real containment
and not a vacuous no-op.

**Finding carried forward, not fixed here:** in this passing run, `stderr` was empty
even though both tool calls were rejected by the OS boundary — 2b.4a's violation
reporting only fires when the *whole* bwrap-wrapped process exits non-zero, and a
live multi-tool-call session that completes successfully overall (exit 0, as this one
does) never reaches that path, even though individual in-session tool calls were
denied. This confirms the "structured supervisor→child diagnostic protocol" gap
above is real, not hypothetical, and remains open.
