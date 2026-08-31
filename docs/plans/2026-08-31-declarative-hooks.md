# Plan: Declarative hooks (spec 2026-08-31-declarative-hooks)

**Status:** In progress -- all tasks committed at `a9675e1ce`; landing (roadmap
row landed, spec `Landed`, this plan deleted) waits on a green CI run.

Task numbers are identifiers, not a sequence. State sits in the table; a task is
**done** only when its check has actually run and passed.

| Task | State | Commit SHA |
| --- | --- | --- |
| HOOKS.1 -- Settings schema: `hooks` key + `getHookSettings()` accessor | **done** -- verified by `test/hooks/settings.test.ts` (3/3) | `a9675e1ce` |
| HOOKS.2 -- `core/hooks/loader.ts`: strict validation (fail closed), matchers, runtime assembly | **done** -- verified by `test/hooks/loader.test.ts` (13/13) | `a9675e1ce` |
| HOOKS.3 -- `core/hooks/command-handler.ts`: stdin JSON, exit-code table, timeout fail-closed, PowerShell on Windows | **done** -- verified by `test/hooks/command-handler.test.ts` (7/7, POSIX-guarded) | `a9675e1ce` |
| HOOKS.4 -- `core/hooks/http-handler.ts`: POST decision, timeout fail-closed, no env interpolation | **done** -- verified by `test/hooks/http-handler.test.ts` (5/5) | `a9675e1ce` |
| HOOKS.5 -- `core/hooks/runtime.ts`: matcher filtering, restriction-only `tool_call` decisions, observe-only lifecycle | **done** -- verified by `test/hooks/runtime.test.ts` (9/9) | `a9675e1ce` |
| HOOKS.6 -- Session bridge: `_installAgentToolHooks` order extensions -> hooks -> gate; `createAgentSession` wiring; children do not inherit | **done** -- verified by `test/hooks/session-wiring.test.ts` (3/3) | `a9675e1ce` |
| HOOKS.7 -- Spec sync (delegation boundary), full `npm test`, plan closure | **done** -- spec boundary note recorded; tsgo clean, biome clean, `check:docs` passed; **full `npm test` exit 0: 3,153 passed / 58 skipped across 373 files** | -- |

## Decisions taken during execution

- **Malformed hook config fails closed at wiring**: `loadHookRuntime` throws
  `HookConfigError`, so a session with an invalid `hooks` key refuses to start
  with the offending path in the message. This mirrors the permission-rule
  posture (a failed rule load blocks rather than falls open) and the spec's
  "rejected at load" wording. Strictness rationale: a silently ignored
  governance entry is a policy hole.
- **Delegation children do not inherit the parent's hook runtime**, mirroring
  the `checkpointSettings` posture in `createAgentSession`. Whether child
  sessions should fire hooks is deferred until the double-fire and authority
  questions are settled; recorded in the spec.
- **Handler-spawn tests are POSIX-guarded.** The command runner is
  PowerShell-aware on Windows, but the spawn-semantics tests drive `sh -c`
  quoting and are `skipIf(win32)`; loader/matcher/runtime tests are
  platform-neutral. Windows-spawn coverage is a follow-up, not a claim made
  here.
- **`session_start` fires detached at construction.** It is observe-only, so it
  must neither delay construction nor be able to fail it; `emitObserve` already
  swallows handler failures.

## Verification record

Per component: failing test first (module-not-found observed for loader/runtime
and handler imports), then implementation, then the narrow file. Gates: `npx
tsgo --noEmit` exit 0; `biome check` clean over `core/hooks`,
`settings-manager.ts`, `agent-session.ts`, `sdk.ts`, `test/hooks`; `npm run
check:docs` passed (roadmap row now links the Active spec); full `npm test`
exit 0 -- 3,153 passed / 58 skipped (373 files) against the pre-change baseline
of 3,113 / 58 (367 files); the +40 tests are the hooks suite.
