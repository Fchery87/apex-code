# Responses tool argument recovery

**Status:** Landed

**Date:** 2026-09-18

## Problem and evidence

The NoteChain session using TheClawBay GPT-6 Astra recorded 95 shell operation
errors. The stored calls combined a command with `kill: true` and an empty
handle. MCP calls repeatedly carried an empty object and returned a successful
instruction message. These observations exclude a terminal rendering problem.

For custom `openai-responses` models without compatibility metadata, the consumed
provider library omits `strict`. Omission permits server-side strict schema
normalization. Explicit non-strict sampling requires `strict: false`, which the
library sends when `compat.supportsStrictMode` is true and experimental sampling
is disabled. Offline public-runtime tests cover both payload shapes without
sending private project content or generated shell commands for execution.

## Design

- Default missing `supportsStrictMode` to true for Responses models composed by
  Apex. Preserve explicit false and other API dialects. Use the public model
  compatibility API without changing the consumed provider library (ADR 0001).
- Accept false for the advertised shell `kill` field. The canonical operation
  parser still rejects actual command-plus-kill and command-plus-handle requests.
- Empty MCP calls throw an error explaining both the accepted operations and the
  `tool_schema` loading step. Deferred schema loading stays explicit (ADR 0011).
- Stop a run after three identical failed tool calls without a successful tool
  result or new user message between them. Compare tool name, arguments with
  object keys sorted, and error content. Different failures may interleave.
  Finish the current tool batch before stopping, retain all result messages, and
  display a local error explaining why the run stopped. No additional model
  request or automatic retry should follow this stop. Success or steering resets
  the failure history; starting a new run starts fresh.
  Retain at most 64 distinct failure signatures. A successful result anywhere in
  a parallel batch counts as progress and resets the history for that batch.

## Verification

Write and run failing tests before each implementation change. Capture outgoing
Responses payloads offline through the public runtime. Cover default/explicit
compatibility settings, deferred MCP schemas, harmless shell flags and rejected
mixed operations, repeated failures, progress resets, and parallel batches.
Run narrow tests, `npx tsgo --noEmit`, the repository checks, and `npm test`.
Verification completed with focused agent tests (49 passed), focused
coding-agent tests (41 passed), the recalibrated replay/context tests (29
passed), `npm run build:offline`, `npx tsgo --noEmit`, `npm run check:scrubber`,
`npm run check:docs`, changed-file Biome checks, and the full suite (3,524
passed, 51 skipped). Credentials never entered artifacts or tracked files.

## Deletion inventory

No modules or APIs are removed. Replace the shell's true-only advertisement,
MCP's successful empty-call response, and implicit Responses strictness default.
Delete the temporary implementation plan on completion.
