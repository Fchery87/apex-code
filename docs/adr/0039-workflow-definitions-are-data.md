# ADR 0039: Workflow definitions are data

**Status:** Accepted · **Date:** 2026-10-31

## Decision

Replace model-facing JavaScript workflows with versioned JSON graphs. Refuse legacy JavaScript without evaluation. The operator authorized implementation of the hardening plan on 2026-10-31, including this format change.

The definition owns stable step identifiers, dependencies, prompt fragments, optional output schemas, phase labels, and final-output references. A pipeline is a dependency chain. Parallel work is a bounded set of named independent steps. References select arguments or prior results through JSON Pointer paths. No reference evaluates code.

Saved requests carry a name and arguments, never a replacement body. The host resolves the saved source before permission evaluation. Approval binds to the resolved digest and the session's trust context. Inline requests carry a definition. They cannot borrow a saved workflow's permission identity.

One interpreter admits work through the existing delegation runtime. The runtime remains responsible for child authority and lifecycle. The interpreter owns the workflow queue and results, not a second permission engine or child registry.

Default limits are 100 attempted starts, four active children reduced by inherited limits, and a one-hour deadline. Cancellation cleanup has a five-second acceptance bound. These are policy limits, not measured performance results. Automatic schema repair and durable workflow replay are disabled.

## Evidence and alternatives

The source investigation is recorded in [the modernization review](../research/2026-10-31-modernization-review.md). The architecture and verification requirements are in [the hardening spec](../specs/2026-10-31-workflow-hardening.md).

A scratch interpreter exercised worker, parallel, pipeline, phase, argument, final-output, and inert code-shaped text fixtures. The prototype and actual output are preserved under `.apex-code/modernization/setup/definition-prototype.ts` and `definition-prototype.log`. This establishes format feasibility only. It does not verify production support or security.

A nested operation tree was considered. It makes local sequencing convenient but complicates cross-branch references and expands admission in several places. A normalized graph makes dependencies and step identity explicit before dispatch. Choose the graph so one queue can enforce all starts.

A stronger VM blacklist still exposes host capabilities through callbacks. A worker thread or subprocess improves termination but does not restrict host credentials or files. Neither is a containment boundary. ADR 0032 remains unchanged.

## Consequences

Legacy executable workflows stop working and receive migration help. Arbitrary programs cannot be automatically converted. The JSON format deliberately omits executable expressions and dynamic loops.

Existing sessions remain readable. Historical `calls.json` files do not authorize replay. Workflow results remain non-resumable until a later slice persists dispatch intent and reconciles children.
