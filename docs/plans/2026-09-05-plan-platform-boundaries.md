# Plan: Platform boundary and escalation remediation

**Status:** In progress

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
| PB.1 | Project only the Linux escalation socket and test the production child path. | verified in `7fa4f340c13adb5ca942266eb7501c51371673a3` | `npm --prefix packages/coding-agent test -- test/sandbox/linux-backend.test.ts test/sandbox/supervisor.test.ts`: Linux launch projections expose only the intended escalation channel. Headless and denied requests fail closed. |
| PB.2 | Move macOS profiles into private supervisor state. | done in `7fa4f340c13adb5ca942266eb7501c51371673a3`, native verification unavailable | `npm --prefix packages/coding-agent test -- test/sandbox/macos-backend.test.ts` passes on Linux. Profile paths and supervisor artifacts stay outside child-writable workspace state, with replacement protections covered at the test seam. A native macOS run is still missing. |
| PB.3 | Replace macOS recursive escalation with a minimal runner. | done in `7fa4f340c13adb5ca942266eb7501c51371673a3`, native verification unavailable | `npm --prefix packages/coding-agent test -- test/sandbox/macos-backend.test.ts` passes on Linux. The runner uses a fresh minimal profile, bounded output, the requested writable root, and no credential, network, terminal, proxy, or escalation channel. A native macOS run is still missing. |
| PB.4 | Stop directory projections from exposing parent siblings. | verified in `7fa4f340c13adb5ca942266eb7501c51371673a3` on Linux; macOS native verification unavailable | `npm --prefix packages/coding-agent test -- test/sandbox/linux-backend.test.ts test/sandbox/macos-backend.test.ts`: grouped projection planning keeps requested descendants available without exposing unrelated parent siblings. Linux execution passed. A native macOS run is still missing. |
| PB.5 | Record platform-specific guarantees and unsupported cases. | verified in `7fa4f340c13adb5ca942266eb7501c51371673a3` | `npm run check:docs` passes. ADR 0005, ADR 0031, and the SDK guide distinguish Linux, macOS, Windows, CLI, SDK, and RPC behavior, including the weaker macOS loopback guarantee and the absence of a Windows backend. |

## Files and boundaries

Implementation files: `packages/coding-agent/src/cli.ts` and `src/core/sandbox/{bwrap-arguments,cli-launch,cli-supervisor,linux-backend,macos-backend,supervisor,terminal-handoff,terminal-size}.ts`. Tests: `test/sandbox/{linux-backend,macos-backend,supervisor,supervisor-state,terminal-handoff}.test.ts`. Documentation: ADR 0005, ADR 0031, and `docs/sdk.md`.

## Narrowed claims

1. **PB.2 and PB.3 lack a fresh native macOS run.** The implementation and platform-specific tests pass on Linux, but Linux cannot execute Seatbelt or prove native profile behavior. These rows are done but not natively verified.
2. **PB.4 has native Linux evidence only.** The macOS projection planner is covered by tests, but native Seatbelt behavior was not rerun.
3. **Windows remains unsupported.** It fails closed rather than receiving a best-effort boundary.
4. **The default parallel `npm test` is not green on this four-CPU host.** Under load it has hit scheduler-sensitive startup deadlines and orphaned Bubblewrap children. Package-scoped serial runs passed: scripts 163 passed and 4 skipped; agent core 430 passed and 1 skipped; coding agent 3,529 passed and 58 skipped across 409 passing files and 6 skipped files.

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
