# Plan: Policy and supervisor authority

**Status:** In progress

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
| PS.1 | Route verification and formatting through canonical command authorization. | verified in `99d138bf55efa3354c9a36ef23c94084cf4f0a24` | `npm --prefix packages/coding-agent test -- test/policy-authorization.test.ts`: 16 tests pass. A `deny` policy and a plan-mode session each leave the command's marker file uncreated, through both the seam and a real `AgentSession`. An `ask` with no responder fails closed. Removing the session wiring fails the two production cases. |
| PS.2 | Enforce formatter scope during execution or through restricted-copy promotion. | verified in `99d138bf55efa3354c9a36ef23c94084cf4f0a24` for workspace mutation | `npm --prefix packages/coding-agent test -- test/formatter-confinement.test.ts`: 9 tests pass. An undeclared write never reaches the live workspace and the run reports `scope-violated`, never `passed`. Before the change 5 of these failed with the stray bytes on disk. Host-wide absolute writes stay unconfined; see Narrowed claims. |
| PS.3 | Move supervisor state and policy snapshots outside child-writable roots. | verified in `7fa4f340c13adb5ca942266eb7501c51371673a3` | `npm --prefix packages/coding-agent test -- test/sandbox/supervisor.test.ts test/sandbox/supervisor-state.test.ts test/sandbox/terminal-handoff.test.ts`: private supervisor paths own handoff, terminal-size, relay, credential, and escalation state. Symlink and replacement cases cannot redirect writes. The child reads the captured supervisor policy snapshot. |
| PS.4 | Harden Git credential execution and protocol validation. | verified in `a87da3471e64e88b5ca5bbeeb4aeee9751fa41c3` | `npm --prefix packages/coding-agent test -- test/sandbox/git-credential-channel.test.ts`: 39 tests pass. Newline, carriage return, NUL, scheme, and host injection are refused with zero calls to `isHostAllowed`, `requestRelease`, and `fillCredential`. A scratch repository whose `credential.helper` touches a marker never creates it, reached both by cwd and through `GIT_DIR`/`GIT_CONFIG`. |
| PS.5 | Document the authority split and SDK embedding contract. | verified in `7fa4f340c13adb5ca942266eb7501c51371673a3` | `npm --prefix packages/coding-agent test -- test/sdk-sandbox-contract.test.ts test/sandbox/supervisor-state.test.ts`: the SDK distinguishes `required`, `external`, and `none`, reports diagnostics, and propagates the selected contract to delegated children. ADR 0031 and the SDK guide record the contract. |

## Files and boundaries

PS.1 and PS.2: `packages/coding-agent/src/core/permissions/policy-command.ts` (new), `src/core/{formatter-lifecycle,verification-lifecycle,policy-executor,agent-session}.ts`. Tests: `test/policy-authorization.test.ts` and `test/formatter-confinement.test.ts` (both new), with `test/formatter-lifecycle.test.ts` updated where it asserted the superseded contract.

PS.4: `src/core/sandbox/rpc/{git-credential-proxy,git-credential-helper}.ts`. Tests: `test/sandbox/git-credential-channel.test.ts`.

PS.3 and PS.5: `src/core/permissions/store.ts`, `src/core/sdk.ts`, and `src/core/sandbox/{cli-launch,cli-supervisor,linux-backend,macos-backend,supervisor,terminal-handoff,terminal-size}.ts`. Tests: `test/sdk-sandbox-contract.test.ts` and `test/sandbox/{supervisor-state,supervisor,terminal-handoff}.test.ts`. Documentation: ADR 0005, ADR 0031, and `docs/sdk.md`.

This plan uses the same documented two-commit close as the startup plan: the implementation commit establishes the real SHA; the close commit records and verifies that SHA in every task row.

## Narrowed claims

1. **PS.2 confines workspace mutation, not the host.** A formatter writing an absolute path outside the workspace still reaches it, and the stage diff cannot see that write, so such a run still reports `passed`. Under the CLI the OS sandbox is the boundary that stops this. An unsandboxed SDK embedding has none. `formatter-confinement.test.ts` encodes this as a named limit so it cannot become a false claim.
2. **PS.2 does not use OS-enforced per-path write restriction.** Erecting a nested sandbox from inside the already-sandboxed child is not possible, and it is a supervisor concern. Copy plus restricted promotion is the portable mechanism, and post-hoc reporting is explicitly not treated as confinement.
3. **PS.2 materializes regular files only.** A workspace symlink is not reproduced in the stage.
4. **PS.4's `GIT_CEILING_DIRECTORIES` guard is unverified by test.** It was confirmed only by shell probe. The empty private cwd is what carries the guarantee.
5. **PS.4 validates git protocol structure, not hostname grammar.** The claim is that a host cannot break out of a git protocol field.
6. **The default parallel `npm test` is not green on this four-CPU host.** Under load it has hit scheduler-sensitive startup deadlines and orphaned Bubblewrap children. Package-scoped serial runs passed: scripts 163 passed and 4 skipped; agent core 430 passed and 1 skipped; coding agent 3,529 passed and 58 skipped across 409 passing files and 6 skipped files.
7. **Native macOS execution was unavailable.** macOS source and test-seam coverage ran on Linux. This plan does not claim a fresh native macOS run.

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
