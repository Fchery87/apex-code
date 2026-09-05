# Plan: Policy and supervisor authority

**Status:** Not started

**Spec:** [`docs/specs/2026-09-05-security-boundary-remediation.md`](../specs/2026-09-05-security-boundary-remediation.md)

**Depends on.** Canonical authorization and execution.

## How to read this

Read the [implementation handoff](../../.apex-code/audit-review-2026-09-05/implementation-handoff.md) for the recommended order and entry checks. The plan tables remain the only task status records.

This plan is one independently verified change. Check a task only when its evidence exists. The owner must preserve existing unrelated working-tree changes. No application code is changed while this plan remains a plan.

Each task starts with a failing public-boundary test. Run the focused check before the next task. Tests that create sessions, policies, workspaces, credentials, or release artifacts use scratch directories. Record the real commit SHA in the task table only after its check passes. Do not claim a full suite is green when a rerun only passes in isolation.

**Verification rule.** Tests alone are not sufficient verification. A task is verified only when its unit test, public-boundary run, and relevant performance or resource check are complete.

## Task table

| ID | Task | State | Verification |
|---|---|---|---|
| PS.1 | Route verification and formatting through canonical command authorization. | not started | A denied verifier spawns nothing. An ask without a responder fails closed. |
| PS.2 | Enforce formatter scope during execution or through restricted-copy promotion. | not started | A formatter targeting `allowed.txt` cannot persist a write to `unrelated.txt` and cannot return `passed`. |
| PS.3 | Move supervisor state and policy snapshots outside child-writable roots. | not started | Symlink substitution cannot redirect handoff writes. Effective policy inside the child equals the supervisor snapshot. |
| PS.4 | Harden Git credential execution and protocol validation. | not started | A hostile repository helper does not execute. Newline, carriage return, NUL, scheme, and host injection fail before authorization. |
| PS.5 | Document the authority split and SDK embedding contract. | not started | SDK tests distinguish required, external, and absent OS containment. |

## Files and boundaries

The owner must list exact files in the first implementation commit. Do not widen the plan to unrelated providers, UI surfaces, or leaked or unlicensed source. Keep tests in scratch directories when they write state.

## Exit conditions

- Every task row has a focused green check and a verified commit SHA.
- The public-boundary tests pass on the supported surface for this plan.
- `npx tsgo --noEmit` passes for TypeScript changes.
- The owner records any full-suite failure without relabeling an isolated rerun as a green full suite.
- Durable decisions are promoted to an ADR or the spec before this plan is deleted.

## Open decisions

Resolve only decisions needed by this plan. Record settled architecture in an ADR. Do not add compatibility shims for unsafe behavior.

## Order changes

None. Add a reason if execution changes the task order.
