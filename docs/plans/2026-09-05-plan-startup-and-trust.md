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
| ST.1 | Parse CLI input once and derive metadata behavior and sandbox selection from the typed result. | verified in `adf4a67f75c43d31689c72cf1be26dbbc218f9ef` | `npm --prefix packages/coding-agent test -- test/sandbox/cli-launch.test.ts test/sandbox/cli-process.test.ts`: metadata-looking values and `--` text enter the sandbox; genuine metadata stays outside. |
| ST.2 | Resolve project trust before constructing permissions, MCP, hooks, and policy startup authority. | verified in `adf4a67f75c43d31689c72cf1be26dbbc218f9ef` | `test/startup-trust.test.ts`, `test/hooks/settings.test.ts`, `test/policy-loader.test.ts`, and `test/mcp/config.test.ts`: resolved trust gates permission scopes and MCP; existing settings gates cover hooks/policy. |
| ST.3 | Prevent child-controlled permission files from changing effective authorization. | verified in `aa3bbb2c4eab49eba465699205ce054139affcd3` | `test/startup-trust.test.ts`: direct and symlink replacement of project and user files leave the next snapshot unchanged; `PermissionStore.apply()` refreshes only its destination; managed policy and runtime scopes remain live. |
| ST.4 | Add the adversarial startup and trust regression suite. | verified in `adf4a67f75c43d31689c72cf1be26dbbc218f9ef` and `aa3bbb2c4eab49eba465699205ce054139affcd3` | Original focused seven-file suite: 85 tests passed. Reopened ST.3 focused permission/startup suite: 3 files and 25 tests passed, including user-file replacement, user-symlink replacement, supported apply refresh, and live managed policy. Scratch workspaces and synthetic connector only; no provider turn or credential. |

## Files and boundaries

Implementation files: `packages/coding-agent/src/cli.ts`, `src/cli/args.ts`, `src/main.ts`, `src/core/sandbox/{cli-launch,child-entry}.ts`, `src/core/permissions/store.ts`, `src/core/mcp/runtime.ts`, and `src/core/sdk.ts`. Tests: `test/sandbox/{cli-launch,cli-process}.test.ts` and `test/startup-trust.test.ts`. The umbrella spec records the settled loader/snapshot scope.

This plan uses a documented two-commit close: the implementation commit establishes the real SHA; the close commit records and verifies that SHA in every task row. No placeholder SHA is recorded.

## Exit conditions

- Every task row has a focused green check and a verified commit SHA.
- The public-boundary tests pass on the supported surface for this plan.
- `npx tsgo --noEmit` passes for TypeScript changes.
- The owner records any full-suite failure without relabeling an isolated rerun as a green full suite.
- Durable decisions are promoted to an ADR or the spec before this plan is deleted.

## Open decisions

Resolve only decisions needed by this plan. Record settled architecture in an ADR. Do not add compatibility shims for unsafe behavior.

## Order changes

Independent verification reopened ST.3 after the original startup slice closed. The verifier found that the sandbox child's workspace-backed `user` permission scope remained live. The user-scope repair in `aa3bbb2c4eab49eba465699205ce054139affcd3` supersedes ST.3's first implementation evidence in `adf4a67f75c43d31689c72cf1be26dbbc218f9ef`; the original commit remains the evidence for ST.1, ST.2, and ST.4.
