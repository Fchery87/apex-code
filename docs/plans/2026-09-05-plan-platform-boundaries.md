# Plan: Platform boundary and escalation remediation

**Status:** Not started

**Spec:** [`docs/specs/2026-09-05-security-boundary-remediation.md`](../specs/2026-09-05-security-boundary-remediation.md)

**Depends on.** Policy and supervisor authority.

## How to read this

Read the [implementation handoff](../../.apex-code/audit-review-2026-09-05/implementation-handoff.md) for the recommended order and entry checks. The plan tables remain the only task status records.

This plan is one independently verified change. Check a task only when its evidence exists. The owner must preserve existing unrelated working-tree changes. No application code is changed while this plan remains a plan.

Each task starts with a failing public-boundary test. Run the focused check before the next task. Tests that create sessions, policies, workspaces, credentials, or release artifacts use scratch directories. Record the real commit SHA in the task table only after its check passes. Do not claim a full suite is green when a rerun only passes in isolation.

**Verification rule.** Tests alone are not sufficient verification. A task is verified only when its unit test, public-boundary run, and relevant performance or resource check are complete.

## Task table

| ID | Task | State | Verification |
|---|---|---|---|
| PB.1 | Project only the Linux escalation socket and test the production child path. | not started | A real Bubblewrap child reaches the intended socket only. Headless and denied requests fail closed. |
| PB.2 | Move macOS profiles into private supervisor state. | not started | Native macOS tests reject pre-existing symlink, replacement, and concurrent profile substitution. |
| PB.3 | Replace macOS recursive escalation with a minimal runner. | not started | The runner has no credential, network, terminal, or unrelated channel and returns bounded output. |
| PB.4 | Stop directory projections from exposing parent siblings. | not started | Linux and macOS projection tests keep sibling files unreadable while requested descendants remain available. |
| PB.5 | Record platform-specific guarantees and unsupported cases. | not started | Documentation and diagnostics distinguish Linux, macOS, Windows, CLI, SDK, and RPC behavior. |

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
