# Plan: Background shell (spec 2026-08-31-background-shell.md)

**Status:** In progress -- opened 2026-08-31

Task numbers are identifiers, not a sequence. A task is **done** only when its
check has actually run and passed.

| Task | State | Commit SHA |
| --- | --- | --- |
| SHELL.1 -- `core/tools/background-shell.ts`: registry (launch/retrieve/kill/dispose, handle resolution for evidence) | **done** -- verified by `test/tools/background-shell.test.ts` (5/5) | -- (this commit) |
| SHELL.2 -- `BashOperations.spawnBackground` (optional) + local backend implementation | **done** -- verified by `test/tools/background-shell.test.ts` + `test/tools/bash-background.test.ts` | -- (this commit) |
| SHELL.3 -- `bash` schema union (launch/retrieve/kill), execute dispatch, escalation note, evidence resolution | **done** -- verified by `test/tools/bash-background.test.ts` (6/6, POSIX-guarded) | -- (this commit) |
| SHELL.4 -- Session wiring: registry created in `createAgentSession`, passed to tools, disposed with the session | **done** -- verified by the wiring test in `test/tools/bash-background.test.ts` | -- (this commit) |
| SHELL.5 -- Gates (tsgo, biome, targeted vitest, full `npm test`), commit, CI, land | **in progress** -- tsgo clean, biome clean, check:docs passed, full coding-agent suite exit 0 (3,164/58 across 375 files); commit + CI pending | -- |

## Decisions taken during execution

- **Retrieve/kill default to allow via a new optional `PermissionSpec.defaultBehaviorFor(params)`**, consulted by the rule engine's no-rule fallthrough only (`rules.ts:100`). Rationale: they perform no new execution — the command was gated at launch — and a static "ask" default would have made every retrieval a prompt interactively and fail closed in headless runs, defeating the feature. Mode floors and matching rules still outrank it; handle calls match the reserved rule content `background-handle` so explicit allow/deny rules and "always allow" persistence work. Launch params are unchanged.
- **Example extensions were narrowed against the new schema union** (built-in-tool-renderer, minimal-mode, permission-gate, plan-mode, rpc-demo) — renderers and `tool_call` handlers now branch on `"command" in input` / cast through `Record<string, unknown>`.

## Verification

Per component: failing test first, then implementation, then the narrow file.
POSIX-guarded spawn cases mirror the declarative-hooks suite's platform guard.
At closure: `npx tsgo --noEmit`, `biome check`, `npm run check:docs`, and the
full `npm test` (both workspaces) as the final gate.
