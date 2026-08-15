# Phase 7 evidence & verification plan

**Status:** In progress

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 7.1 Inventory evidence and settle ownership | Done | `81a84d730` | ADR 0007, Phase 7 spec, and contract inventory identify the current capture declarations, absent sink, JSONL authority, and optional policy boundary. |
| 7.2 Define evidence records, sink, and persistence | Done | `79e57decb` + `58c54951b` + `bf25fdf28` | Typed source sink, durable JSONL evidence and diagnostic entries, per-record IDs/session metadata, credential-key rejection, append/reload, and direct AgentSession lifecycle capture tests. Artifact-reference validation and factual-size limits land with producer artifacts in 7.3. |
| 7.3 Capture bash evidence at source | Done | `d7296ee61` | Bash execution details now carry source-observed cwd, executable, argv, and exit code; source capture tests cover normalized facts. Non-zero and timeout paths retain structured source details through `ToolExecutionError`, with direct and AgentSession capture tests. |
| 7.4 Capture edit/write evidence at source | Done | `d7296ee61` | Scratch mutation tests verify write byte count/content hash and edit patch hash, while asserting raw mutated content is absent from evidence. |
| 7.5 Add normalized test execution evidence | Done | `07b11310e` + `db19cb857` + `2feb0ef7c` | Explicit argv-only `test` tool records normalized executable, arguments, cwd, and non-zero exit status. Agent-core `ToolExecutionError` preserves source details for failed bash execution without parsing rendered output. |
| 7.6 Wire optional policy consumption | Done | `369c9e7bd` | Public optional extension consumes immutable durable evidence snapshots after capture and returns no tool-result patch; capture requires no policy extension. |
| 7.7 Measure and close Phase 7 | Done | `c82584312` | A tracked-file audit found no `gatedFailures()` implementation or calibration corpus, so no false-positive threshold was invented. Clean no-space Node v22.21.1 validation passed: `npm ci --ignore-scripts && npm run build && npm run check && npm test` — 277 passed / 6 skipped test files; 2311 passed / 53 skipped tests. |

## Order changes

None.

## Shared implementation rules

- Tests that execute tools or write session state use scratch directories and clean them up.
- Never persist API keys, tokens, full file contents, or unrestricted command output.
- Capture facts at the source; do not reconstruct evidence from rendered model text.
- Keep policy interpretation separate from core evidence emission.
- Record the real commit SHA only in the same commit that completes a task.
