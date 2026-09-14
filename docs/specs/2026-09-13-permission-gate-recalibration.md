# Spec: Recalibrate the permission gate for a harness with no boundary

**Status:** Active

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Created | `2026-09-13` |
| Last updated | `2026-09-13` |
| Roadmap phase | `none (follows ADR 0032, which removed the layer these defaults assumed)` |
| Tracking issue/PR | branch `docs/permission-gate-recalibration` |
| Compatibility posture | Two behavior changes, both narrowing. `acceptEdits` stops auto-allowing a write whose target is outside the workspace, and the read-shaped tools stop returning the agent directory's `auth.json` without a decision. Rule syntax, the eight-source precedence, the five mode names, project trust, and every tool's declared capabilities are untouched. A session that only edits its workspace sees no change. |

## Executive summary

[ADR 0032](../adr/0032-no-built-in-sandbox.md) removed the process boundary and stated that the permission gate "is untouched, and it is a different layer... Removing it is a separate decision this ADR does not make." That is right about removing the gate and wrong about leaving it as it stood. Two of the gate's behaviors were calibrated against mounts that no longer exist, so deleting the mounts changed what they mean without changing a line of their code.

`acceptEdits` auto-allows any edit-shaped call with no path term in the decision at all. Under the mounts that meant the workspace. It now means every path the account can write. The read-shaped tools default to `allow` with no containment check. Under the mounts the home directory was hidden and one credential file was deliberately bind-mounted; now the whole home directory is readable and `auth.json` sits in it.

This change scopes `acceptEdits` to the workspace and adds a refusal for the agent directory's credential file that no project or local rule can express. It does not revisit any other default.

## Context and motivation

The credential half is not new. It is goal 8 of [`2026-09-11-trust-classification-and-proof-integrity.md`](2026-09-11-trust-classification-and-proof-integrity.md), written on 2026-09-11 and still open. That spec was written while the boundary existed, so it scoped the finding to one deliberately mounted file. ADR 0032 landed the next day and widened the same finding to the entire home directory without citing it. The goal moves here, because the cause is now ADR 0032 rather than trust classification, and because it shares that cause with the `acceptEdits` defect.

The `acceptEdits` half is new and was found by probe on 2026-09-13.

## Current state

| Area | Current behavior | Evidence |
|---|---|---|
| `acceptEdits` | Auto-allows on capability shape alone. `params` is not a parameter of `resolveWithMode`, so the target path is unreachable, not merely unused. | `core/permissions/modes.ts:31-40`, `:66-68` |
| Write execution | A `path-new` write opens the filesystem root and creates every missing parent under it. There is no base-path argument. | `core/tools/path-utils.ts:146`, `:156-166`, `:193-231` |
| Mode description | The selector still calls the mode "plain file edits", wording chosen when the mounts made that true. | `modes/interactive/components/settings-selector.ts:54`, `README.md:300` |
| Read-shaped tools | `read`, `grep`, `ls`, and `find` default to `allow`. | `core/tools/read.ts:229`, `core/tools/grep.ts:148`, `core/tools/ls.ts:120`, `core/tools/find.ts:141` |
| Path authorization | 53 lines, no root, no base, no containment predicate. An out-of-workspace path normalizes to its absolute form and is matched as a glob. | `core/tools/path-permission.ts` |
| Credential storage | Cleartext JSON at mode `0600`, which protects against other accounts and not against this one. | `core/auth-storage.ts`, `config.ts:570` |
| Path preparation | `preparePathOperation` resolves lexically. It never calls `realpathSync`, so a symlink inside the workspace resolves to a path inside the workspace. | `core/tools/path-utils.ts:22-35`, `utils/paths.ts:28-34` |

Three probes, run on 2026-09-13 against `6408ab9af`, drove the real `AgentSession` with a real `FilePermissionRuleStore` and the gate installed. A control write in `default` mode with no responder was denied, which proves the gate was live. In the same configuration `read` on an out-of-workspace `auth.json` was allowed with no ask and the key reached the transcript. With only the mode changed to `acceptEdits`, a write created a directory chain outside the workspace and planted a file.

## The problem

A mode named for edits authorizes writes anywhere the account can reach, and its own description tells the user otherwise. A gate that asks before sending data out stays silent while data is collected, and the most valuable file it can collect is the one the harness itself wrote.

Neither is a containment failure, because there is no containment to fail. Both are calibration failures. The gate is now the only layer that acts at runtime, and two of its settings still assume a second layer underneath.

## Goals

- [ ] `acceptEdits` auto-allows a write only when the target resolves inside the workspace. A target outside it falls through to the behavior the rules and the mode would otherwise give, which is `ask`.
- [ ] The workspace test resists a symlink. A path inside the workspace that resolves outside it is outside it.
- [ ] `acceptEdits` is described in terms that match what it does, in the settings selector and in `README.md`.
- [ ] `read`, `grep`, `ls`, and `find` refuse the agent directory's `auth.json` without an explicit decision, and that refusal is not expressible as a project or local rule.
- [ ] The refusal names the file and states the alternative, so a user who legitimately wants that content knows how to supply it.
- [ ] Every change above is pinned by a probe that drives a real session, not a unit call, and each probe is observed failing before its fix lands.

## Non-goals

- [ ] This does not revisit the read-shaped tools' `allow` default in general. Reading source is the ordinary case and prompting for it would make the harness unusable. Only the credential file is refused.
- [ ] This does not add containment. ADR 0032 settled that, and nothing here confines a subprocess, an extension, or a path reached outside the tool gate.
- [ ] This does not gate `AGENTS.md` or `CLAUDE.md` through project trust. That remains open and belongs with the trust classifier, not with the gate.
- [ ] This does not change `bash`. Its grammar-sensitive matcher already fails closed and is the part of the gate that was built to be load-bearing.
- [ ] This does not encrypt `auth.json`. Refusing a read path is not key management, and pretending otherwise would be the failure class `2026-08-29-documented-surfaces-that-do-not-exist.md` exists to prevent.

## Design

**Where the workspace test lives.** `PermissionSpec` gains an optional `withinWorkspace(params)`, implemented by `createPathPermissionSpec`, which already holds both the `cwd` and the path accessor. `evaluateToolCall` calls it and passes the answer to `resolveWithMode`. Path semantics stay in the path spec and `modes.ts` stays free of path logic.

The alternative, moving the `acceptEdits` overlay into `gate.ts` where `params` is already in scope, was rejected. It splits mode resolution across two files, and `policy-command.ts:60` also calls `resolveWithMode` and would then disagree with the gate about what a mode means.

**How the workspace test resists a symlink.** `getCwdRelativePath` is the right comparison but takes a lexical path. The predicate resolves the nearest existing ancestor of the target with `realpathSync`, re-appends the remaining segments, and compares against the resolved `cwd`. Using the nearest existing ancestor rather than the target is what makes it work for a `path-new` write, whose target does not exist yet.

**Where the credential refusal lives.** A denied-path set consulted before rule resolution, so no `project` or `local` rule can express an allow for it. It sits alongside the managed `policy` check in `resolveWithMode`, which is the existing precedent for a decision that outranks `bypassPermissions`, and follows that precedent for the same reason: a rule file a repository can write must not be able to unlock it.

`bypassPermissions` does not lift the refusal. The 2026-09-11 design note asked for exactly this, and the mode's own confirmation already tells the user that nothing else confines the session, which is an argument for keeping one floor rather than none. The cost is that a user debugging their own credential file is refused by their agent; the message names the file and says to supply the contents deliberately instead. Recorded here so it is a decision rather than an oversight.

**What is refused.** The agent directory's `auth.json`, resolved through `getAuthPath()` so an `APEX_CODE_AUTH_PATH` override is covered, compared after the same symlink-resistant resolution the workspace test uses. Not the whole agent directory: sessions, settings, and themes live there and are ordinary reads.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| Goal 8 of `docs/specs/2026-09-11-trust-classification-and-proof-integrity.md` | doc | moved here; the row in that spec's plan points at this spec |
| The "plain file edits" wording in `modes/interactive/components/settings-selector.ts` | doc | replaced, the mode is scoped now |
| The `acceptEdits` sentence in `README.md` | doc | replaced for the same reason |
| Nothing in `core/permissions/rules.ts`, `core/permissions/store.ts`, or any tool contract | code | unchanged; this adds a floor and narrows one overlay |

## Rollout

Goal order, one slice each, each ending in a check.

1. The `acceptEdits` workspace scope, with its probe and the two description fixes.
2. The credential refusal, with its probe.

The descriptions ship with the behavior rather than after it, because a mode whose description is corrected before its behavior is corrected is briefly wrong in the other direction.

## Open questions

None. Both alternatives considered above are recorded as decisions.
