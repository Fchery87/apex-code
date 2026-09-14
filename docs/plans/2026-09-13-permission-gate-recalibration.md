# Plan: Permission gate recalibration after the boundary removal

**Status:** Active

Execution breakdown for [`docs/specs/2026-09-13-permission-gate-recalibration.md`](../specs/2026-09-13-permission-gate-recalibration.md). The spec's Rollout sets the order: the `acceptEdits` scope first with its description fixes, then the credential refusal.

## Tasks

| Task | State | Evidence |
|---|---|---|
| Reproduce both defects against a real session | complete | Probes drove `AgentSession` with a real `FilePermissionRuleStore` and the gate installed. A control write in `default` mode with no responder was denied, proving the gate live. `read` on an out-of-workspace `auth.json` returned the key; `acceptEdits` wrote outside the workspace and created the parents. Probes were scratch and are re-landed as kept tests by the two slices below. |
| Scope `acceptEdits` to the workspace | complete | `PermissionSpec.withinWorkspace`, implemented in `core/tools/path-permission.ts`, called from `core/permissions/gate.ts` and consumed by `core/permissions/modes.ts`. |
| Make the workspace test resist a symlink | complete | Resolve the nearest existing ancestor with `realpathSync`, re-append the remainder, compare against the resolved cwd. The nearest existing ancestor rather than the target, because a `path-new` write has no target yet. A dangling link is reported outside: `existsSync` follows links so it reads as absent, and judging it by where the link sits rather than where it points would auto-allow a write the executor then refuses. Found in review. |
| Correct the mode's description | complete | Both said "plain file edits", wording the mounts used to make true. `modes/interactive/components/settings-selector.ts` now reads "Auto-allow file edits inside the workspace; still ask for anything outside it, commands and network", and `README.md` says the mode auto-allows edits whose target stays inside the workspace and still asks for one that leaves it. |
| Refuse the agent directory's `auth.json` on the read-shaped tools | complete | A denied-path set consulted before rule resolution, beside the managed `policy` check in `core/permissions/modes.ts`. Resolved through `getAuthPath()` so an `APEX_CODE_AUTH_PATH` override is covered. |
| Keep one probe per goal | complete | Each under `packages/coding-agent/test/security-boundary/`, driving a real session, observed failing before its fix. |

## Carried forward, not fixed here

`AGENTS.md` and `CLAUDE.md` still reach the system prompt with no trust gate. That belongs with the trust classifier and is tracked by the 2026-09-11 plan.

The read-shaped tools keep their `allow` default for every path but the one refused here. `~/.ssh`, `~/.aws`, and shell history stay readable, which ADR 0032 records as an accepted consequence of having no containment.

## Verification

Task rows carry their own evidence as they land.

Slice 1 is `18697ca93`, verified with `git cat-file -t`. It carries the workspace
predicate, the `PermissionSpec` hook, the gate and mode wiring, both description fixes,
and the kept probe at `test/security-boundary/accept-edits-workspace-scope.test.ts`.

Probe observed failing first at `b03588f76`: two of its four cases failed, and the two
controls passed in both states. `npm run check` passed in the pre-commit hook at both
commits. Targeted sweep of `test/permissions` and `test/security-boundary`, 275 passed.
Wider sweep of `test/tools`, `test/suite`, `policy-authorization`, and
`formatter-confinement`, 104 files and 541 passed.

That wider sweep failed two files on its first run and passed all 104 on a rerun of the
identical command, with every file also passing when run in smaller groups. The box was at
load 12.7 on four cores. Recorded rather than dropped, because a flake that is never
written down gets rediscovered. Three-OS CI is the evidence that settles it.
