# Plan: Permission gate recalibration after the boundary removal

**Status:** Active

Execution breakdown for [`docs/specs/2026-09-13-permission-gate-recalibration.md`](../specs/2026-09-13-permission-gate-recalibration.md). The spec's Rollout sets the order: the `acceptEdits` scope first with its description fixes, then the credential refusal.

## Tasks

| Task | State | Evidence |
|---|---|---|
| Reproduce both defects against a real session | complete | Probes drove `AgentSession` with a real `FilePermissionRuleStore` and the gate installed. A control write in `default` mode with no responder was denied, proving the gate live. `read` on an out-of-workspace `auth.json` returned the key; `acceptEdits` wrote outside the workspace and created the parents. Probes were scratch and are re-landed as kept tests by the two slices below. |
| Scope `acceptEdits` to the workspace | not started | `PermissionSpec.withinWorkspace`, implemented in `core/tools/path-permission.ts`, called from `core/permissions/gate.ts` and consumed by `core/permissions/modes.ts`. |
| Make the workspace test resist a symlink | not started | Resolve the nearest existing ancestor with `realpathSync`, re-append the remainder, compare against the resolved cwd. The nearest existing ancestor rather than the target, because a `path-new` write has no target yet. |
| Correct the mode's description | not started | `modes/interactive/components/settings-selector.ts` and `README.md` both say "plain file edits", wording the mounts used to make true. |
| Refuse the agent directory's `auth.json` on the read-shaped tools | not started | A denied-path set consulted before rule resolution, beside the managed `policy` check in `core/permissions/modes.ts`. Resolved through `getAuthPath()` so an `APEX_CODE_AUTH_PATH` override is covered. |
| Keep one probe per goal | not started | Each under `packages/coding-agent/test/security-boundary/`, driving a real session, observed failing before its fix. |

## Carried forward, not fixed here

`AGENTS.md` and `CLAUDE.md` still reach the system prompt with no trust gate. That belongs with the trust classifier and is tracked by the 2026-09-11 plan.

The read-shaped tools keep their `allow` default for every path but the one refused here. `~/.ssh`, `~/.aws`, and shell history stay readable, which ADR 0032 records as an accepted consequence of having no containment.

## Verification

Task rows carry their own evidence as they land.
