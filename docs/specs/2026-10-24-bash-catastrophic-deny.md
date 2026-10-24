# Spec: Bash catastrophic deny

**Status:** Active

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-10-24 |
| Last updated | 2026-10-24 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility. A command that does not match the deny runs exactly as it does today, including an unparseable command, which still asks. A command that matches is refused where it used to ask or run. No setting, rule, or session entry changes shape. A saved allow rule that names one of these commands stops matching it. That is the point of the change, not a migration. |

## Executive summary

`bash` will refuse a command whose target is the filesystem root, the home directory, or a credential location, and neither a saved allow rule nor `bypassPermissions` can lift that refusal. The refusal is a permission decision. It is not a sandbox, and it does not inspect the bytes the command would write.

## Context and motivation

- `docs/adr/0032-no-built-in-sandbox.md` removed the OS boundary. Isolation is the operator's container. The permission gate stayed, and it is policy, not containment.
- `docs/adr/0038-optional-bash-confinement.md` wraps `bash` in `bwrap` only when the user settings file turns that on. It is off by default and does not cover this case.
- `packages/coding-agent/src/core/permissions/protected-paths.ts` already refuses credential paths for the path-shaped tools. The bash spec does not declare `protectedTarget`, so that protection never runs for a shell command.
- Jcode's `jcode-command-risk` crate classifies shell commands by blast radius and treats destruction of home, root, or credentials as a deny no model justification can unlock. This spec records that behavior. It does not copy that crate's types, parser, or wording.

## Current state

`createBashPermissionSpec()` defaults to `ask`. A single read-only segment is allowed. An unparseable command is unknown, so an allow rule cannot match it and a deny rule matches all of them. `resolveWithMode()` returns allow for `bypassPermissions` before it consults an ordinary rule, and the protected-target branch that would outrank that mode only runs when the spec declares `protectedTarget`. Bash does not.

Measured against `evaluateToolCall` with the real bash contract on 2026-10-24: a user rule `{ toolName: "bash", behavior: "allow" }` allowed `rm -rf /`, `find . -delete`, and `sh -c "rm -rf ~"` with no responder. `rm -rf ~` asked, because the tilde makes the command unparseable, and an approving responder then allowed it. `bypassPermissions` allowed `rm -rf /` with no responder. The same call, reading `~/.ssh/id_rsa` through the `read` tool, was refused under `bypassPermissions`. `bash` execute parses the command and spawns it. It does not classify the target again.

## The problem

A saved allow rule, or one mode flag, turns a command that deletes the filesystem root into a command that runs. The path tools already refuse the credential locations that command can also reach. The shell is the path around that refusal.

## Goals

- [ ] `rm -rf /`, `rm -rf ~`, `rm -rf /home`, `find . -delete` when `.` resolves to the home directory or `/`, and `sh -c "rm -rf /"` are denied by the gate.
- [ ] A user, project, session, or command allow rule for `bash` does not lift the denial. `bypassPermissions` does not lift it either.
- [ ] The denial names the target. It does not offer a session grant, because no rule would be written.
- [ ] `git status`, `rm file.txt` inside the workspace, and an unparseable command that names no catastrophic target keep today's behavior.
- [ ] A denied command produces no spawn. The gate returns before execute.

## Non-goals

- [ ] A general destructive-command taxonomy. `git reset --hard`, `git push --force`, and `git clean -f` stay on the existing prompt and the system-prompt warning. Classifying every destructive git verb is a different spec.
- [ ] Refusing writes inside the workspace. `rm` of a project file remains an ordinary bash decision.
- [ ] Parsing redirections, command substitution, or globs. Those already return unparseable and ask. This spec does not start authorizing them.
- [ ] Restoring the OS sandbox. ADR 0032 stands. A determined `python -c` that deletes a file still runs when the gate allows `python`. The deny covers the commands whose target the existing segment parser can see, plus the unparseable forms that name `/`, `~`, or a home path as text.
- [ ] Changing `read`, `grep`, `find`, `ls`, `edit`, or `write`. Their protected-target behavior already holds.

## Proposed solution

Add one predicate, `bashCatastrophicTarget(command, cwd, home)`, used by the bash permission spec. It returns a reason string or undefined.

The predicate runs on the command string before rule resolution. A hit makes `defaultBehaviorFor` return `deny`, and `allowRuleGrants` return false for every rule, so a blanket allow cannot win. `resolveWithMode` already refuses to let `bypassPermissions` outrank a protected target. Bash will report one by returning that reason from `protectedTarget`. The mode layer then asks, and the no-responder branch refuses. To make an interactive approval fail too, `allowRuleGrants` is not enough: the ask branch still allows when the user says yes. `protectedTarget` plus a deny from `defaultBehaviorFor` is the refusal, and the gate's deny branch returns before the responder. `bypassPermissions` is handled by teaching `resolveWithMode` nothing new: a spec-level deny has to win before the mode overlay. The implementation therefore returns the denial from `evaluateToolCall` when `protectedTarget` is set and the spec's `defaultBehaviorFor` is `deny`, ahead of the `bypassPermissions` short-circuit. Path tools do not set `defaultBehaviorFor` to deny for a protected target, so their ask-under-bypass behavior is unchanged.

| Component | Change | File |
| --- | --- | --- |
| Target predicate | Root, home, and credential-location targets on `rm`, `rmdir`, `shred`, `unlink`, and `find -delete`. Unwrap `sudo`, `command`, `xargs`, and `sh -c` / `bash -c` one level. | `packages/coding-agent/src/core/tools/bash-catastrophic.ts` |
| Permission spec | Report the reason as `protectedTarget`. Deny before rules. | `packages/coding-agent/src/core/tools/bash.ts` |
| Mode overlay | A protected target whose spec denies stays denied under `bypassPermissions`. | `packages/coding-agent/src/core/permissions/modes.ts` |

`beforeToolCall` stays the only gate. The predicate is part of the tool's own permission spec, which is the ADR 0010 rule that the tool owns its grammar.

A target counts when it is `/`, a path that resolves to `/`, `~`, a path that resolves to the home directory, or a path inside a credential location `protected-paths.ts` already names. `find <path> -delete` counts when `<path>` resolves to one of those. A relative path resolves against the session cwd. `rm -rf /tmp` does not count. `rm -rf "$HOME"` stays unparseable because of `$` and is denied by the text scan, which treats `$HOME`, `${HOME}`, and `~` as the home directory when they appear as the target word.

## Deletion inventory

Nothing existing is removed. The ask for these commands is replaced by a deny. That is a behavior change, not a deleted module.

## Risks

The text scan looks at the program and its target word, not at every quoted string. `echo "rm -rf /"` is not a delete, and the test shows it still asks. A command the scan misses still asks, which is today's behavior. The dangerous miss is an interpreter one-liner, and the non-goal below records it.

`python -c "import shutil; shutil.rmtree('/')" ` is not denied. The non-goal says so. If that becomes the observed bypass, the predicate grows an interpreter case. It does not grow one now.

## Verification

- `packages/coding-agent/test/permissions/bash-catastrophic.test.ts` drives `evaluateToolCall` with the real bash contract. Each catastrophic command is denied with an empty rule set, with a user allow-all rule, and under `bypassPermissions`, with and without a responder.
- The same file shows `git status` allowed, `rm file.txt` asking, and `echo hello` asking.
- `npx tsgo --noEmit` is clean.
- `npm --prefix packages/coding-agent test -- test/permissions test/tools/bash` passes.

No roadmap phase gate applies.

## Rollout

Small enough to implement directly. No plan doc. No ADR: the decision fits the existing protected-target rule, and the mode change is the one-line consequence of a spec that denies. If the mode change turns out to affect a path tool, that is a bug, not a new decision.
