# Phase 7 evidence & verification plan

**Status:** In progress

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 7.1 Inventory evidence and settle ownership | Done | `81a84d730` | ADR 0007, Phase 7 spec, and contract inventory identify the current capture declarations, absent sink, JSONL authority, and optional policy boundary. |
| 7.2 Define evidence records, sink, and persistence | Done | `79e57decb` | Typed source sink, durable JSONL evidence and diagnostic entries, per-record IDs/session metadata, credential-key rejection, append/reload, and direct AgentSession lifecycle capture tests. Artifact-reference validation and factual-size limits land with producer artifacts in 7.3. |
| 7.3 Capture bash evidence at source | Not started | — | Non-zero exit, timeout, argv, cwd, and output-reference tests. |
| 7.4 Capture edit/write evidence at source | Not started | — | Scratch mutation tests with patch/content hashes and no content retention. |
| 7.5 Add normalized test execution evidence | Not started | — | Fixture command normalization and exit-status tests. |
| 7.6 Wire optional policy consumption | Not started | — | Capture works without policy; policy reads records without becoming a core gate. |
| 7.7 Measure and close Phase 7 | Not started | — | `gatedFailures()` baseline comparison, full validation, roadmap update, plan deletion. |

## Order changes

None.

## Shared implementation rules

- Tests that execute tools or write session state use scratch directories and clean them up.
- Never persist API keys, tokens, full file contents, or unrestricted command output.
- Capture facts at the source; do not reconstruct evidence from rendered model text.
- Keep policy interpretation separate from core evidence emission.
- Record the real commit SHA only in the same commit that completes a task.
