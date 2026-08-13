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
| 2b.4c Reconcile CLI tests broken by sandboxing becoming the default launch route | Done | `8465f033f` | `test/session-file-invalid.test.ts`, `test/session-id-readonly.test.ts`, `test/startup-session-name.test.ts` (10 tests) green individually and combined; full `test/sandbox/` + `test/permissions/gate-universal.test.ts` (40 tests) green; `npx tsgo --noEmit` clean; remaining pre-existing baseline failures re-confirmed unrelated (see below) |
| 2b.4d Implement the network allowlist proxy (UDS relay + supervisor-side allowlist) | Done | `a149cc43b`, cleaned up `66c53cc79` | `test/sandbox/network-allowlist.test.ts` (new, 1 test); full `test/sandbox/` + `test/permissions/gate-universal.test.ts` (9 files/41 tests); `npx tsgo --noEmit`; `npm run build`; see review findings below |
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

**2b.4c.** A full `npm --workspace packages/coding-agent test` baseline (taken before
any 2b.4c change) showed 15 failing tests across 8 files. Triaged individually, not
assumed from the roadmap's older baseline list, since that list predates this phase:

- **Three files were genuine regressions from sandboxing becoming the default
  launch route**, not pre-existing: `session-file-invalid.test.ts`,
  `session-id-readonly.test.ts` (3 tests), and `startup-session-name.test.ts` (2
  tests) all spawn the CLI in `-p`/print mode without `--permission-mode`. Since a
  headless session now fails closed without it (2a), every one of these tests hit
  `Error: Non-interactive sessions require an explicit --permission-mode` before
  ever reaching its actual assertion. Fixed by adding `--permission-mode default`
  (chosen because none of these tests exercise a tool call — they fail on
  session-level validation first, so the choice of mode doesn't affect what's being
  asserted). One test in `session-id-readonly.test.ts` ("does not warn when
  --session-id opens an existing session") had the same bug but was passing
  *vacuously* — its assertion is `not.toContain(...)`, which stayed true once the
  stderr content changed to the unrelated permission-mode error. Fixed alongside
  the rest even though it wasn't in the failing list, since a green test that isn't
  testing its claim is worse than a red one.
- `startup-session-name.test.ts` also had a fixture bug independent of the flag:
  `dirs.sessionFile` was a *sibling* of `dirs.projectDir` (`tempRoot/session.jsonl`
  vs. `tempRoot/project/`), not inside it, while `cwd: dirs.projectDir` is what
  becomes the sandbox workspace — the exact "fixtures place mutable session files
  outside the workspace" failure mode flagged going into this task. Fixed by moving
  the session file under `projectDir`.
- The same file's client-side kill watchdog (`setTimeout(() => child.kill(...),
  10_000)`) proved too tight under real load now that every spawn is a real
  Bubblewrap child with real startup cost, not a plain Node process — it passed
  clean in isolation but intermittently hit the 10s SIGKILL under concurrent test
  load. Bumped to 25s (safely under the file's 30s `testTimeout`).
- **Five files were re-confirmed as pre-existing and structurally unrelated to
  sandboxing** — none of them spawn `cli.ts` as a subprocess at all:
  `external-editor.test.ts` (in-process `editInExternalEditor()`; root cause
  identified as unquoted shell-string interpolation breaking on the space in this
  repo's own directory name, `.../Coding Projects/apex-code` — a pre-existing
  fragility, not something 2b introduced or this task's scope to fix),
  `radius.test.ts` (in-process `ModelRuntime.create()` fetch-spy timeout),
  `skills.test.ts` (in-process tilde-expansion logic), `tools.test.ts` (missing
  `rg` binary, a host dependency gap), and
  `6999-models-json-hot-reload.test.ts` (in-process TUI model-selector
  rendering).

A full clean `npm test` run proved infeasible to obtain in this environment during
this task — repeated attempts (full monorepo, coding-agent-only, reduced
concurrency, fully serial) were killed by the surrounding environment partway
through regardless of approach, load-average evidence pointing at resource
contention from this session's own accumulated background activity rather than a
product issue. Verification instead used targeted runs covering the full set of
originally-failing files plus the sandbox and permission-gate suites, which is a
narrower but complete guarantee for the surface this task touched.

**2b.4d.** Turned the 2026-08-12 spec amendment's validated design (UDS relay
through the unchanged `--unshare-net` isolation, no new dependency) into a real
implementation: `core/sandbox/network-proxy.ts` (new) is the supervisor-owned HTTP
CONNECT allowlist proxy, bound to a Unix domain socket under the workspace's
`.apex-code/sandbox-state/`; `linux-backend.ts` writes a small in-child relay script
that listens on the child's own private loopback and pipes to that socket, and sets
`HTTP_PROXY`/`HTTPS_PROXY` for the launched command; `settings-manager.ts` adds a
`network.allowedHosts` settings surface threaded through `cli.ts` →
`launchSandboxedCli` → `createSandboxPolicy` → the backend. The `--unshare-net`
child keeps zero network interfaces beyond loopback, unchanged from 2b.1–2b.4c — a
direct-connect attempt still has no route to anywhere, matching the amendment's
"no route to fall back on" claim regardless of whether a client honors the proxy
env vars.

This landed as commit `a149cc43b`, authored directly rather than through this
plan's usual TDD-and-review sequence, with no preceding spec/plan update recording
the decision to move from design to implementation. Reviewing it against the repo's
own verification discipline before accepting it surfaced five real problems, fixed
in follow-up commit `66c53cc79`:

1. **The new test hardcoded a personal, non-portable absolute path** —
   `command: "/home/nochaserz/.bun/bin/bun"` — an undeclared third-party runtime at
   a path that exists only on one developer's machine, unlike every other sandbox
   test's `process.execPath`. It would fail outright (not skip) on any other host
   or CI. Rewritten to use `process.execPath`, matching the existing pattern.
2. **A violation's `detail` field was fabricated, not observed**: a policy-based
   403 refusal was recorded as `"Network is unreachable: ..."`, language that
   claims a kernel-level condition that did not occur, chosen to match a test
   assertion rather than the test verifying real behavior. Rewritten to an honest
   description (`"Host <hostname> refused by allowlist policy."`), and the vague
   `command: "proxy"` field replaced with the real `CONNECT <hostname>:<port>`
   request line.
3. **Debug output left in production code**: unconditional `console.error` calls
   in `linux-backend.ts` on every sandboxed launch, contradicting the commit's own
   claim of having removed temporary debugging output. Removed.
4. **Two scratch/debug files were committed**: `packages/coding-agent/test-proxy.js`
   (a standalone debugging script) and `test/sandbox/test.test.ts` (a single
   assertion-free `console.log` test), contradicting the commit's claim of having
   deleted temporary testing files. Deleted.
5. **Stale-socket hardening, not present in the original**: `createSandboxNetworkProxy`
   now unlinks a pre-existing socket file at its bind path before listening, since a
   prior launch that never reached `close()` (a crash, a SIGKILL) would otherwise
   leave a stale Unix socket file blocking every subsequent launch in the same
   workspace.

**Known limitation carried forward, not fixed here:** a blocked connection is
currently recorded twice — once accurately by the proxy (`kind: "network"`), and a
second time by `linux-backend.ts`'s existing process-exit classifier, which falls
back to a generic `kind: "unknown"` record whenever the whole sandboxed process
exits non-zero for a reason its stderr regex doesn't recognize (here, the launched
command's own clean `process.exit(1)` after being refused at the HTTP layer, not an
OS-level message). This predates 2b.4d — the classifier's fallback behavior is
unchanged — but the network proxy makes it more visible, since an allowed HTTP
client now regularly exits non-zero for reasons that have nothing to do with an OS
refusal. Not addressed here to keep this task's scope to what was reviewed; a
future evidence-protocol pass (see 2b.4b's finding) should decide whether the outer
classifier ought to suppress its own record when a more specific one was already
recorded for the same launch.

The allowlist proxy also does hostname-string equality only, not a resolved-IP
check at connect time as the spec amendment's design described, and does not
enforce port as part of the allowlist (`network.allowedHosts` is a bare hostname
list with no port field) — both are described in the amendment as the target
design; this implementation is a first cut against it, not a full match, and both
gaps remain open.
