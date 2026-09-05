# Plan: Startup and trust remediation

**Status:** In progress

**Spec:** [`docs/specs/2026-09-05-security-boundary-remediation.md`](../specs/2026-09-05-security-boundary-remediation.md)

**Depends on.** None.

## How to read this

Read the [implementation handoff](../../.apex-code/audit-review-2026-09-05/implementation-handoff.md) for the recommended order and entry checks. The plan tables remain the only task status records.

This plan is one independently verified change. Check a task only when its evidence exists. The owner must preserve existing unrelated working-tree changes. No application code is changed while this plan remains a plan.

Each task starts with a failing public-boundary test. Run the focused check before the next task. Tests that create sessions, policies, workspaces, credentials, or release artifacts use scratch directories. Record the real commit SHA in the task table only after its check passes. Do not claim a full suite is green when a rerun only passes in isolation.

**Verification rule.** Tests alone are not sufficient verification. A task is verified only when its unit test, public-boundary run, and relevant performance or resource check are complete.

## Task table

| ID | Task | State | Verification |
|---|---|---|---|
| ST.1 | Parse CLI input once and derive metadata behavior and sandbox selection from the typed result. | not started | Public CLI tests for option values, positional text, `--`, `--help`, and `--version`. Run the focused CLI suite. |
| ST.2 | Resolve project trust before constructing permissions, MCP, hooks, and policy startup authority. | not started | Scratch trusted and untrusted projects prove project loaders differ only after the trust decision. |
| ST.3 | Prevent child-controlled permission files from changing effective authorization. | not started | An `acceptEdits` public session attempts writes and symlink replacement. The next snapshot remains unchanged. |
| ST.4 | Add the adversarial startup and trust regression suite. | not started | The suite covers CLI, SDK, MCP, hooks, permission files, and negative controls at the public boundary. |

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
