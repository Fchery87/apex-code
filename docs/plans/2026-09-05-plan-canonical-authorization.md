# Plan: Canonical authorization and execution

**Status:** Not started

**Spec:** [`docs/specs/2026-09-05-security-boundary-remediation.md`](../specs/2026-09-05-security-boundary-remediation.md)

**Depends on.** Startup and trust remediation.

## How to read this

Read the [implementation handoff](../../.apex-code/audit-review-2026-09-05/implementation-handoff.md) for the recommended order and entry checks. The plan tables remain the only task status records.

This plan is one independently verified change. Check a task only when its evidence exists. The owner must preserve existing unrelated working-tree changes. No application code is changed while this plan remains a plan.

Each task starts with a failing public-boundary test. Run the focused check before the next task. Tests that create sessions, policies, workspaces, credentials, or release artifacts use scratch directories. Record the real commit SHA in the task table only after its check passes. Do not claim a full suite is green when a rerun only passes in isolation.

**Verification rule.** Tests alone are not sufficient verification. A task is verified only when its unit test, public-boundary run, and relevant performance or resource check are complete.

## Task table

| ID | Task | State | Verification |
|---|---|---|---|
| CA.1 | Define discriminated operation variants and validated boundary values for paths, Bash, commands, credentials, and evidence. | not started | Typecheck and boundary parser tests reject malformed external values. |
| CA.2 | Migrate path authorization and execution to one canonical target. | not started | `@` paths, symlink aliases, new-write parents, and literal glob filenames pass gate-then-execute tests. |
| CA.3 | Replace Boolean Bash matching with structured allow, deny, unknown, and no-match results. | not started | Scoped denies cover mixed and unsupported commands. Lower allows cannot erase higher restrictions. |
| CA.4 | Preserve exact shell structure in approvals. | not started | Altered quoted whitespace, newlines, comments, and escapes cannot reuse an approval. |
| CA.5 | Prove complete mediation across every registered tool and foreign tool fallback. | not started | Registry-driven tests show every invocation reaches the gate and unclassified tools default conservatively. |

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
