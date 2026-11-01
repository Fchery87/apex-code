# Harden workflow execution before expanding orchestration

**Status:** Active

## Outcome

Workflow users can coordinate bounded children without granting workflow definitions arbitrary host JavaScript execution. Maintainers inherit one admission path and explicit outcomes instead of VM callbacks, completion-count limits, and null results.

This spec addresses the immediate correctness findings in [the modernization review](../research/2026-10-31-modernization-review.md). Implementation is authorized and H1 is in progress. The design is not evidence of remediation. Verification remains pending.

## Bound the current slice

Replace the unsafe execution boundary, bind saved workflow identity, validate structured results, enforce admission limits, and propagate cancellation. Correct verification invalidation and product claims touched by these changes. Do not promise crash-safe workflow recovery in this slice.

Detailed specs for recovery, evaluations, delivery, and remote execution wait until this slice exits. Their entry conditions belong in the roadmap.

## Replace executable bodies with data

Use a versioned JSON workflow definition. A definition contains stable step identifiers, dependencies, a worker request per step, optional output schema, phase labels, and an explicit final-output reference. Bounded fan-out expands into named steps before admission. A pipeline is a dependency chain. References select a prior output through validated JSON Pointer paths.

Do not support expressions, imports, callbacks, loops, dynamic evaluation, or interpolation that executes code. Validate the entire graph before starting a child. Reject duplicate identifiers, unknown dependencies, cycles, oversized documents, and references outside dependency ancestry. Treat prompts and outputs as data.

The host interpreter calls the existing delegation runtime. It does not implement permissions or classify tools again. Every child retains the derived authority and capability ceiling of ADR 0008. No subprocess or worker thread is described as containment. ADR 0032 remains in force.

Proposed organizing modules are `workflow-definition.ts`, `workflow-scheduler.ts`, and `workflow-output.ts` beside `core/delegation/workflow-run.ts`. The runner composes them. Keep session storage and child ownership in their existing modules.

## Resolve saved identity before permission approval

Separate saved invocation from inline invocation with a discriminated request. A saved invocation carries an identifier and arguments. It cannot carry a replacement body. The host resolves the trusted source and hashes the validated definition before evaluating permission rules. An inline invocation carries a definition and requires approval scoped to session, trust context, and digest.

Reject path-like workflow and run identifiers before filesystem access. Use an ASCII identifier grammar with a length bound. Preserve loader symlink refusal and test ancestor-directory handling. Resolve duplicate saved names deterministically or refuse them with a diagnostic. Never choose an ambiguous body silently.

Invalidate approval on source, digest, project-trust, or session changes. Recheck the resolved digest immediately before execution. Exercise headless, SDK, and saved slash-command paths through the full permission gate.

## Make admission and outcomes explicit

All worker starts use one scheduler. Reserve the total-call budget synchronously before dispatch. Queued and active reservations count toward the 100-attempt ceiling. Count any repair attempt as a new attempt. Default concurrency is four, reduced by the inherited child limit. Reject zero or invalid limits. Wait for capacity rather than returning null.

Use terminal outcomes `succeeded`, `failed`, `cancelled`, and `blocked`. Only success carries validated output. Failure carries a bounded diagnostic and attempt identity. Blocked dependencies never dispatch. Define stop-on-failure as the default and require explicit configuration to continue independent branches.

Propagate an AbortSignal and a finite deadline from tool entry through admission and child interruption. A pre-aborted call dispatches nothing. Cancellation stops new admission, cancels queued work, and awaits bounded child cleanup. Proposed default deadline is one hour. Treat this as a policy proposal to confirm during execution, not a measured optimum. Do not restore arbitrary JavaScript to implement a timeout.

Parse whole JSON documents with byte and nesting bounds. Support scalar, array, and object outputs. Publish a bounded JSON Schema subset with types, required fields, properties, additionalProperties, items, enum, and numeric/string limits. Reject unsupported dialects, remote references, and unknown keywords before dispatch. Choose the existing schema machinery if it supports this contract, otherwise add one pinned validator with dependency and license checks. Disable automatic schema repair initially. A bad result fails explicitly.

## Preserve compatibility honestly

Reject legacy JavaScript workflows with a migration diagnostic. Do not auto-convert arbitrary programs and do not fall back to the old VM. Provide examples mapping worker, parallel, pipeline, phase, arguments, and final output into JSON definitions. Keep `delegate` and the child lifecycle API unchanged.

Old `calls.json` files remain readable as historical artifacts but cannot authorize reuse in the new runner. Mark new results as non-resumable until the next slice implements dispatch reconciliation. Preserve session-format compatibility under ADR 0006.

## Invalidate verification through declared contracts

Replace the independent `MUTATING_TOOLS` set with `buildToolContractSnapshot()` and observed workspace revision changes. Inspect the existing contract fields before selecting the predicate. Do not add a second registry of tool classifications. Unknown observations produce an explicit unverified state. Test extension and MCP mutation declarations, read-only commands, and changes after verification.

## Verify the exit

Every implementation task starts with a public-boundary failing test in scratch. Require denial of legacy host execution, forged names, stale approvals, and path traversal. Require full schema rejection, bounded fan-out, cancellation cleanup, and unchanged child authority. Run focused tests, `npx tsgo --noEmit`, `npm run check`, and one root `npm test` per completed slice. Require three-OS CI and packed runtime smoke evidence before declaring the slice landed.

Use [the implementation plan](../plans/2026-10-31-workflow-hardening.md) for commands, PR boundaries, and receipts. No existing review probe is counted as a passing remediation test.

## Deletion inventory

Delete VM execution, the import substring guard, process-global approved-body authority, brace slicing, partial schema checks, completion-order reuse, and independent mutation classification when their callers migrate. Remove advertised JavaScript containment and reliable-resume claims. Preserve historical research and existing session artifacts. Do not delete unrelated plans or upstream experimental modules without ownership and reachability evidence.
