# Plan: Canonical authorization and execution

**Status:** In progress

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
| CA.1 | Define discriminated operation variants and validated boundary values for paths, Bash, commands, credentials, and evidence. | verified in `f0c1368ca7be3164c171c79641aaa13945bd3e5f`, narrowed to path operations | `npx tsgo --noEmit` exits 0. `PreparedPathOperation` is a discriminated union over `path-existing` and `path-new` carrying a validated absolute `CanonicalPath` plus a captured `FileIdentity`. Command, credential, and evidence variants were removed rather than declared without production callers; see Narrowed claims. |
| CA.2 | Migrate path authorization and execution to one canonical target. | verified in `f0c1368ca7be3164c171c79641aaa13945bd3e5f` for read, write, and edit | `npm --prefix packages/coding-agent test -- test/permissions/canonical-authorization.test.ts`: 16 tests pass, covering `@` paths, symlink aliases, new-write parents, and literal glob filenames. grep, find, and ls pin the authorized pathname but are not fd-pinned; see Narrowed claims. |
| CA.3 | Replace Boolean Bash matching with structured allow, deny, unknown, and no-match results. | verified in `f0c1368ca7be3164c171c79641aaa13945bd3e5f`, no typed operation reaches the gate | `npm --prefix packages/coding-agent test -- test/permissions/bash-grammar.test.ts test/permissions/bash-command-segments.test.ts`: unparseable grammar cannot satisfy an allow, a deny matches any segment, and a scoped deny beats a lower blanket allow. The matcher still consumes parser-produced strings; see Narrowed claims. |
| CA.4 | Preserve exact shell structure in approvals. | verified in `f0c1368ca7be3164c171c79641aaa13945bd3e5f` | `test/permissions/canonical-authorization.test.ts`: a persisted approval taken through `evaluateToolCall` matches only the identical command. Altered quoted whitespace, an appended comment, and an appended newline each fail closed to `block: true`. |
| CA.5 | Prove complete mediation across every registered tool and foreign tool fallback. | verified in `f0c1368ca7be3164c171c79641aaa13945bd3e5f` when a gate is configured | `npm --prefix packages/coding-agent test -- test/permissions/gate-universal.test.ts test/permissions/canonical-authorization.test.ts`: every ordinary built-in, the conditional LSP registry, and the conditional MCP registry reach the gate through the public agent loop; a foreign tool with no contract resolves to `UNCLASSIFIED` and fails closed with no responder. The gate stays optional in `AgentSessionConfig`; see Narrowed claims. |

## Files and boundaries

Implementation files: `packages/coding-agent/src/core/permissions/{operations,gate,rules}.ts` and `src/core/tools/{path-utils,path-permission,read,write,edit,grep,find,ls,bash,bash-command-segments,contract}.ts`. Tests: `test/permissions/canonical-authorization.test.ts`, with `test/lsp/{navigation-tool,workspace-symbol}.test.ts` updated for the new execute arity.

This plan uses the same documented two-commit close as the startup plan: the implementation commit establishes the real SHA; the close commit records and verifies that SHA in every task row. No placeholder SHA is recorded.

## Narrowed claims

These are recorded rather than left as implied guarantees. Each one is a limit an independent verifier found or the implementer chose, not a deferred task.

1. **Descriptor-pinned execution covers read, write, and edit only.** grep, find, and ls execute against the gate-authorized canonical pathname but do not hold a directory descriptor, so an intermediate directory swapped between authorization and execution remains a theoretical window for those three tools.
2. **The walked-descriptor chain needs `/proc/self/fd`.** On platforms without it the final-component `O_NOFOLLOW` open and the descriptor identity check still apply, but intermediate components are opened by pathname prefix. The behavior verified here is Linux-only.
3. **Only path operations carry a prepared operation.** Bash keeps its grammar-sensitive string-segment matcher. Command, credential, and evidence operation classes were removed rather than declared with no production caller.
4. **Complete mediation holds when a permission gate is configured.** The gate remains optional in `AgentSessionConfig`; a session without one performs no authorization, by design.
5. **New files are created mode 0600.** This is deliberate hardening and a visible behavior change.

## Verification evidence

- `npm --prefix packages/coding-agent test -- test/permissions/`: 13 files, 220 tests pass.
- Mutation check. Forcing `getPreparedPathOperation()` to return `undefined` and changing nothing else fails 6 of 16 canonical-authorization cases (the agent-loop read race, four write races, the edit race) and passes the other 10. The race tests bite.
- Full coding-agent workspace suite: 405 files, 3458 tests pass, 58 skipped.
- `npx tsgo --noEmit` exits 0.
- Independent review and the implementer's response are recorded in [`.apex-code/security-remediation/ca-verifier.md`](../../.apex-code/security-remediation/ca-verifier.md).

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
