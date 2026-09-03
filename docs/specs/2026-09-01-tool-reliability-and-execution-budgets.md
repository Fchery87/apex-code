# Spec: Tool reliability and execution budgets

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-09-01 |
| Last updated | 2026-09-02 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility. Existing successful tool calls and session entries remain valid. Failure results gain bounded detail. New loop budgets are additive and configurable, with an explicit compatibility choice for callers that do not configure a budget. New LSP operations do not change existing operation names or result shapes. |

## Executive summary

Apex Code's standalone `test` tool can lose the output needed to fix a failing test, and failed edits do not identify safe candidate locations. The agent loop has host stop hooks but no built-in configurable safety budget. The LSP tool also lacks workspace-wide symbol lookup. This spec adds bounded diagnostics, typed loop budgets, and a separately authorized `workspace/symbol` operation without applying guessed edits or running unbounded scans.

## Context and motivation

- `docs/research/2026-09-01-agentic-harness-capability-audit.md` and `docs/research/2026-09-01-harness-architectural-audit.md` identify these gaps. Their similarity and capture snippets are sketches, not accepted patches.
- `docs/specs/2026-09-01-harness-correctness-and-workspace-state.md` owns compaction workspace state and checkpoint navigation. This spec owns the independent tool and loop contracts.
- `docs/architecture/contracts.md` requires every tool to declare permission, context, capability, and evidence behavior from one contract.
- The normal `bash` path already captures bounded output and artifacts. The standalone `test` path must follow that public behavior without copying its implementation blindly.

## Current state

| Area | Current behavior | Evidence |
| --- | --- | --- |
| Test output | `test` drains child stdout and stderr and returns a status string. | `packages/coding-agent/src/core/tools/test.ts:41-42,88-95` |
| Edit failures | Missing and duplicate matches return generic errors. The current normalizer is deliberately limited. | `packages/coding-agent/src/core/tools/edit-diff.ts:27-45,207-274,316-331` |
| Loop control | `runLoop` has no built-in budget for provider requests, tool calls, or wall time. Host stop hooks exist. | `packages/agent/src/agent-loop.ts:168-209,259-272`; `packages/agent/src/types.ts` |
| LSP | Supports document symbols, definitions, and references. It lacks `workspace/symbol`. | `packages/coding-agent/src/core/tools/lsp.ts:13-284` |

## The problem

A failing test without its bounded error output cannot close the test-fix loop. An edit failure without locations or a safe reason causes retries based on guesses. A provider or tool loop can continue making requests until a host hook, context overflow, or human stop ends it. Workspace-wide symbol discovery requires slow fallback searches even when an LSP server supports the operation.

The audit's proposed Dice-window matcher and hardcoded loop limit are not sufficient production contracts. Similarity must remain advisory and source-aware. A budget must define exactly what it counts and how it interacts with cancellation and queued work.

## Goals

- [x] Capture stdout and stderr from the standalone `test` tool with separate structured fields, a bounded model-facing view, exit/signal/timeout/cancellation status, and artifact references where the existing artifact policy permits.
- [x] Report output byte and line counts, truncation, and omitted-output metadata. Keep complete command output out of the JSONL session ledger and evidence records.
- [x] Add bounded edit-failure diagnostics with safe candidate ranges and duplicate occurrence locations. Candidate diagnostics must never apply an edit.
- [x] Make candidate scanning line-aware and source-offset-safe across CRLF, tabs, Unicode normalization, and repeated text. Disable or shorten the advisory scan when caps are exceeded.
- [x] Add a typed loop budget with independently configurable provider-request, tool-call, and wall-time limits. Define exact boundary behavior, stop reasons, and event ordering.
- [x] Ensure cancellation and explicit user stop take precedence over budget exhaustion. Ensure queued steering and follow-up work cannot bypass the selected budget policy.
- [x] Add `workspace/symbol` with workspace-root permission checks, cancellation, response caps, normalized paths/ranges, and malformed-response handling.
- [x] Keep every changed or new tool compliant with the canonical tool contract projection.

## Non-goals

- [ ] Making the edit tool silently accept approximate matches. Existing authoritative matching remains the only apply path.
- [ ] Running a general fuzzy search across unlimited file size or returning unlimited source snippets.
- [ ] Changing normal `bash` output behavior or replacing its existing artifact store.
- [ ] Choosing an arbitrary default limit of 50 provider turns or tool calls without replay and workload measurements.
- [ ] Adding a universal retry policy for provider or tool failures.
- [ ] Turning `workspace/symbol` into a text-search fallback. If the server does not support it, return a bounded unsupported result.
- [ ] Adding pre-completion verification or automatic formatting. Those belong to `docs/specs/2026-09-01-configured-verification-and-formatting.md`.

## Alternatives considered

- **Keep the silent test output.** Rejected because exit status alone cannot support model-led correction.
- **Return the entire test output inline.** Rejected because output can be unbounded and can contain secrets. Bounded views and artifacts preserve the existing output policy.
- **Use Dice similarity as an automatic edit fallback.** Rejected because approximate edits can change the wrong source. Use similarity only for advisory diagnostics.
- **Add one hardcoded loop counter.** Rejected because provider requests, tool calls, retries, and wall time have different costs and failure modes.
- **Use only host stop hooks.** Rejected because every caller would need to implement safety and non-interactive modes could omit it.
- **Add an independent LSP classifier.** Rejected because tool metadata must come from the canonical contract snapshot.

## Proposed solution

### 1. Test output

Refactor the standalone `test` operation to collect stdout and stderr through bounded accumulators. Preserve separate streams in structured details and provide a bounded combined display for the model. If exact cross-stream ordering cannot be preserved by the child-process API, state that limitation rather than implying ordering.

The result must distinguish `exit`, `signal`, `timeout`, `cancelled`, and spawn failure. It must include exit code when available, `stdoutBytes`, `stderrBytes`, shown line/byte counts, `truncated`, and an artifact reference when complete output is retained outside the result. The process may continue after the model-facing cap so the command's exit status remains authoritative, but memory and artifact limits must still apply.

The artifact reference must follow the existing artifact ownership, access, retention, and permission rules. Full output does not enter durable evidence. Evidence records contain bounded status and references only.

### 2. Edit diagnostics

Keep exact and current fuzzy matching as the only application path. On a missing match, an advisory diagnostic may report a small number of closest line windows. On duplicate matches, it may report bounded source line ranges. Candidate search must:

- operate against source lines or a source-to-normalized offset map;
- cap input file bytes, target bytes, scan work, candidates, snippet lines, and snippet bytes;
- preserve CRLF and Unicode source offsets when reporting lines;
- avoid returning the full searched text when it is unnecessary;
- return no candidates when safe bounds are exceeded; and
- escape or label source-controlled text as diagnostic content.

A diagnostic is not evidence that an edit is valid. It must never turn a candidate into an applied replacement.

### 3. Loop budget

Add a typed policy at the agent-core boundary:

```ts
interface AgentRunBudget {
  maxProviderRequests?: number;
  maxToolCalls?: number;
  maxWallTimeMs?: number;
}
```

The final type may add explicit retry or compaction fields, but it must define these units:

- A provider request is one request sent to the model, including a retry request and a local compaction summarization request only if the caller opts into counting it under that policy.
- A tool call is one accepted tool call execution, whether the tool batch runs sequentially or concurrently.
- Wall time begins when the logical run starts and ends when it settles.

The policy must state whether a continuation shares the parent budget. The default must be selected from replay/workload measurements and documented in settings. A caller that needs unlimited behavior must opt into an explicit compatibility mode and still remains cancellable.

Use this precedence for terminal outcomes:

1. cancellation or explicit user stop;
2. tool, provider, or host failure;
3. budget exhaustion;
4. normal completion.

When a tool batch reaches a budget boundary, already-started calls finish or cancel according to the existing abort contract. No new provider request starts after a known exhausted budget. Emit a structured stop reason and preserve normal lifecycle event ordering. Steering and follow-up queues may not bypass the budget; the policy must say whether they share, extend, or are rejected by the current run.

### 4. Workspace symbols

Add a distinct `workspace_symbol` operation that sends `workspace/symbol` only after workspace-root permission checks. Normalize every returned URI/path and range through the existing LSP helpers. Apply result count, output byte, and serialized-details caps. Return explicit notices for omitted or truncated results, empty responses, malformed items, unsupported servers, cancellation, and server errors. Do not broaden the permission root merely because a symbol result points outside it.

## Settled budget policy (2026-09-02, TR.3)

The defaults and unit decisions below are selected from measured evidence and
are binding for TR.4/TR.5. Measurements and their derivation:
[docs/research/2026-09-02-run-budget-measurements.md](../research/2026-09-02-run-budget-measurements.md).

- Default `maxProviderRequests`: **200** per logical run.
- Default `maxToolCalls`: **2000** per logical run.
- Default `maxWallTimeMs`: **none this release** (unset means unlimited; the
  field stays configurable).
- Continuations share the logical run's budget. Steering, follow-up,
  post-run continuations, and provider-failure retries are the same run; a new
  run starts at each user prompt.
- Compaction summarization uses a **separate maintenance budget**: it does not
  consume `maxProviderRequests` and is recorded separately for observability.
- Unbounded behavior is an explicit per-field `"unlimited"` opt-in in settings;
  there is no implicit unlimited path.

## Landed behavior (2026-09-02, TR.7)

What shipped, as a reference for the fields and bounds other surfaces read.

### Test result fields (`test` tool)

- `details.outcome`: `exit` | `signal` | `timeout` | `cancelled` | `spawn-failed`; `details.exitCode`; `details.signal` (signal name or null); `details.spawnErrorMessage` for spawn failure.
- `details.stdout` / `details.stderr`: per-stream metadata only — `totalBytes`, `totalLines`, `shownBytes`, `shownLines`, `truncated`, `truncatedBy`, and `fullOutputPath` when the complete stream was retained as an artifact. Raw stream text never enters details, evidence records, or anywhere else in the ledger; the model-facing bounded view (labeled stdout/stderr sections, with an explicit interleaved-ordering disclaimer when both streams produced output) is the only inline text.
- An optional `timeout` parameter (seconds) kills the detached runner process group; timeout and cancellation surface as `ToolExecutionError` with details preserved, matching the bash tool's convention. Exit status stays authoritative after the display cap is hit.
- Evidence capture emits bounded facts only: `kind`, `cwd`, `executable`, `argv`, `exitCode`, `outcome`, `outputTruncated`.

### Edit diagnostic caps (`edit` tool)

- Advisory only, appended to the ordinary failure message: missing matches list up to 3 closest line windows (bigram Dice, ≥ 0.2 similarity) with line-numbered snippets; duplicate matches list up to 5 occurrence lines plus a `+N more` count.
- Caps: 1,048,576 file bytes, 65,536 target bytes, 20,000 scored windows, 50 ms scan deadline, 160 characters per snippet line. Exceeding any budget returns the ordinary failure plus a bounded `(Advisory diagnostic scan skipped …)` notice instead of scanning.
- Matching and apply behavior are unchanged; diagnostics never supply replacement locations or content.

### Loop budget units and defaults

- Units (spec § 3): one provider request counted per request the loop sends (retries and continuations included; provider-internal transparent retries stay below this boundary, bounded by provider retry settings); one tool call counted when the loop accepts it for execution; wall time from logical-run start to settlement.
- Defaults (from the settled policy above): 200 provider requests, 2000 tool calls, no wall-time limit. `runBudget` settings resolve per field with `"unlimited"` opting out; malformed values throw before any session runs.
- Continuations share the logical run's budget; a fresh budget starts at each user prompt. Compaction summarization is recorded via `maintenanceRequests` and never consumes `maxProviderRequests`.
- `agent_end` carries `stopReason`: `aborted` > `error` > `budget-exhausted` (with the exhausted limit) > `completed`. No new provider request starts after known exhaustion; unstarted calls in a batch fail with a bounded budget error. The session event, JSON/RPC/ACP event streams, and print mode's stderr report the same structured reason.

### `workspace_symbol` permissions and bounds

- One operation on the existing `lsp` tool. The request goes out only after the same path permission grammar authorizes the workspace root (a path-less call normalizes to the root; one rule grammar, one gate, `allow` default unchanged).
- Results are normalized through the existing LSP helpers (relative paths, one-based ranges), capped at 2,000 symbols and a 256 KiB serialized-details budget with honest `truncated` counts; malformed items count as `omitted`; results outside the authorized root are dropped with an `outsideRoot` count and never widen the root.
- Empty responses are normal bounded results; a `-32601`/method-not-found rejection becomes a bounded `unsupported: true` result; cancellation and other server errors propagate unchanged.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| Silent stdout/stderr draining in the standalone `test` tool | behavior | superseded by bounded structured capture. |
| Generic edit failure results with no bounded location hints | behavior | superseded by advisory diagnostics. |
| Unbounded default agent execution | behavior | superseded by an explicit configurable budget policy. |
| Any independent tool classification for the new LSP operation | behavior | rejected. The canonical contract snapshot remains authoritative. |

Existing tool names, successful result semantics, and session entries remain readable.

## Risks

- Test output can contain credentials or private source. Bounds, artifact permissions, and evidence exclusions must be tested.
- A bounded view can hide the useful error. Separate stream counts, truncation metadata, and an artifact reference must make that visible.
- Candidate snippets can expose source or mislead the model. Source-aware offsets and advisory-only application must be tested.
- A budget can stop valid work or count retries incorrectly. Boundary tests must cover exact limits, queued work, compaction, retries, and all modes.
- Workspace symbols can return paths outside the allowed root or malformed ranges. Permission and normalization tests must reject or safely cap them.

## Verification

| Contract | Evidence |
| --- | --- |
| Test output | Passing, failing, timed-out, cancelled, signal-terminated, spawn-failure, and high-volume scratch commands assert structured status, bounded output, counts, truncation, artifact policy, and no full output in the ledger. |
| Edit diagnostics | Missing, duplicate, CRLF, tabs, Unicode, repeated-text, large-file, and cap-exceeded cases assert safe lines and no automatic approximate edit. |
| Loop budget | Agent-core tests assert each unit, exact boundaries, precedence, cancellation, retries, compaction, steering, follow-up, and structured stop events across interactive, print, JSON, RPC, and ACP callers. |
| Workspace symbols | LSP tests assert workspace-root permission, normalization, empty/malformed responses, caps, cancellation, unsupported servers, and server errors. |
| Contract projection | Tool registry tests prove the new/changed declarations use `buildToolContractSnapshot()` and do not introduce a second classifier. |

Run focused tests first, then `npx tsgo --noEmit`, `npm test`, and `npm run check`. Tool and session tests must use scratch directories. Record the initial budget default and its replay/workload basis before marking the goal complete. Agent-core sources reach the coding-agent suite through the built workspace `dist/`, so `npm --prefix packages/agent run build` must run after any `packages/agent/src` change before coding-agent tests can exercise it.

## Rollout

This spec needs a plan because it changes agent-core lifecycle semantics and several public tool result paths. Create a plan after this Draft spec is approved. Implement test capture and edit diagnostics first, then loop budgets, then workspace symbols. If the loop budget becomes an irreversible public SDK contract, record it in an ADR before implementation.
