# Plan: Tool reliability and execution budgets

**Status:** In progress

**Spec:** [Tool reliability and execution budgets](../specs/2026-09-01-tool-reliability-and-execution-budgets.md)

## Tasks

| # | Task | State | SHA | Verified by |
| --- | --- | --- | --- | --- |
| TR.1 | Capture bounded output from the standalone `test` tool | Done | `4d03e750c` | New public-tool tests for pass, fail, timeout, cancellation, signal, spawn failure, UTF-8 boundaries, high volume, artifact policy, and ledger exclusion; `npx tsgo --noEmit` |
| TR.2 | Add bounded advisory edit-failure diagnostics | Done | `3c2af739c` | New public edit-tool tests for missing, duplicate, CRLF, tabs, Unicode, repeated text, cap exceeded, stable line mapping, and no approximate application; `npx tsgo --noEmit` |
| TR.3 | Measure run behavior and select the budget compatibility/default policy | Done | `7ca5f179c` | Replay corpus and representative driven-loop report checked into the spec or research note; settings/default tests pin the chosen policy before implementation |
| TR.4 | Implement the agent-core run budget and structured stop reason | Done | `f67fb6cb3` | `packages/agent/test/agent-loop.test.ts` covers provider requests, tool calls, wall time, retries, tool batches, cancellation precedence, exact boundaries, steering, follow-up, and continuation semantics |
| TR.5 | Wire budgets through settings and every execution mode | Done | `1339436ab` | Focused SDK/session, interactive, print, JSON, RPC, and ACP tests prove one policy and one structured outcome across callers; existing mid-run compaction suites remain green |
| TR.6 | Add permission-safe `workspace_symbol` | Not started | — | LSP and permission suites cover workspace-root authorization, normalization, caps, malformed/empty responses, unsupported servers, cancellation, outside-root results, and canonical contract projection |
| TR.7 | Update documentation and close the gates | Not started | — | Focused suites above, `npx tsgo --noEmit`, `npm test`, `npm run check`, `node scripts/validate-docs-lifecycle.mjs .`, and required CI evidence |

States: `Not started`, `In progress`, `Done, unverified`, `Done`.

`Done` requires a real SHA that passes `git cat-file -t` and the verification named in the row.

## Task details

### TR.1: Capture bounded output from the standalone `test` tool

Drive `createTestTool()` through its public execute boundary. First prove that a failing fixture returns no diagnostic text. Then add separate structured stdout and stderr metadata, a bounded combined model view, actual process outcome, and a permitted artifact reference. Preserve exit authority after the display cap while bounding memory and artifact writes.

Reuse the normal command-output conventions where their lifecycle fits. Do not put full output into session JSONL or evidence records.

**Done when:** every process outcome and bound in the row is covered, and the original silent-failure regression passes.

### TR.2: Add bounded advisory edit-failure diagnostics

Write public edit-tool failures before changing the matcher. Keep exact/current accepted matching authoritative. Add source-line-aware candidate and duplicate locations under explicit file, target, work, candidate, line, byte, and time caps. When a cap is exceeded, return the ordinary failure with a bounded notice rather than guessing.

**Done when:** diagnostics give useful locations without changing apply behavior, and mutation testing or an equivalent negative assertion proves advisory candidates cannot be applied.

### TR.3: Measure run behavior and select the budget compatibility/default policy

Measure provider requests, tool calls, continuations, retries, and wall time across the replay corpus and representative synthetic loops. Decide whether unconfigured callers receive a finite default in this release or an explicit compatibility mode followed by a staged default. Record the number and evidence in the spec before production wiring.

Also settle whether local compaction summarization requests consume the same provider-request budget or a named maintenance budget. Do not hide this decision in code.

**Done when:** the spec names the selected policy and limits, with reproducible measurement output and tests that fail under the old unbounded behavior.

### TR.4: Implement the agent-core run budget and structured stop reason

Add the typed budget at the lowest loop boundary. Count one provider request when a request is sent and one tool call when execution is accepted. Define batch behavior before calls start. Cancellation or explicit user stop wins over failure, budget exhaustion, and normal completion in that order specified by the spec.

No new request starts after known exhaustion. Existing tool results and lifecycle events keep their order.

**Done when:** the narrow agent-loop suite proves exact boundaries and `npx tsgo --noEmit` is clean.

### TR.5: Wire budgets through settings and every execution mode

Pass one normalized policy from settings/SDK construction into agent-core. Avoid separate counting in interactive, print, JSON, RPC, or ACP adapters. Expose the same typed stop reason in each mode's native result/event form. Preserve mid-run compaction and queued-message behavior.

**Done when:** all mode tests pass and a missing adapter wire causes a focused test to fail.

### TR.6: Add permission-safe `workspace_symbol`

Add one LSP operation rather than a separate tool. Request `workspace/symbol` only after workspace-root authorization. Normalize and cap every result. Omit or reject results outside the authorized root according to the permission contract, and report counts honestly. Build all registry descriptions through `buildToolContractSnapshot()`.

**Done when:** LSP, permission, and contract snapshot suites pass with no second tool classifier.

### TR.7: Update documentation and close the gates

Document test-result fields, edit diagnostic caps, budget units/defaults, structured termination, and workspace-symbol permissions. Run the full gates and required CI.

**Done when:** every prior task has a verified SHA, the spec and roadmap carry the landed state in the same final commit, and this plan is deleted through the normal close process.

## Order changes

None.

## Notes

TR.1 and TR.2 are independent and may be implemented in either order. TR.3 must finish before TR.4. TR.4 must land before TR.5. TR.6 is independent after the contract review.

Tests that run commands or sessions use scratch directories and may not write Apex's own session or evidence state.

TR.3's pinning test was written and observed red (`getRunBudget` missing, 6 failures) before the settings implementation landed, as test-first requires. The red state itself was not committed: the pre-commit gate runs `tsgo --noEmit` over the whole tree, so a test referencing a not-yet-existing getter cannot compile in any commit. The red observation and its reason are recorded here instead. The same applies to the TR.3 "fails under the old unbounded behavior" requirement: the enforcement test in TR.5 (`run-budget-wiring.test.ts`) fails without the sdk.ts budget wire, which was verified during debugging when the rebuilt-agent-dist mismatch left the wire ineffective (runBudget undefined, test red).

One environment fact worth keeping: the coding-agent vitest suite resolves `apex-code-agent-core` through the workspace link to built `dist/` (the vitest alias list only covers the old upstream `@earendil-works/*` names), so agent-core source changes require `npm --prefix packages/agent run build` before coding-agent tests exercise them.
