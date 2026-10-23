# Spec: Optional confinement for bash

**Status:** Draft

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-10-23 |
| Last updated | 2026-10-23 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility. `bash` stays unconfined unless the user sets `bash.confinement` to `"on"`. ADR 0032 stays in force. The permission gate is unchanged. `read`, `grep`, `find`, `ls`, and extensions do not gain a confinement path. |

## Executive summary

ADR 0032 removed the OS sandbox and told the user to supply a container or a VM. The other coding CLIs still confine the shell itself, off by default, and fail closed when the helper is missing. Apex Code has no such option.

This spec adds one setting, `bash.confinement: "on"`. When it is on, a bash call runs inside a platform helper that can see the workspace and an allowlist of hosts. When the helper is missing, the call is refused. The setting does not claim to confine any other tool.

## Context and motivation

- `docs/research/2026-10-22-coding-agent-cli-gap.md` ranks this fourth. It asks one question. Can a bash call be limited to the workspace files and an allowlist of hosts, without a supervisor, a proxy, or a second permission classifier? It says the feature is off unless the user turns it on, fails closed when the helper is missing, and must say the limit ADR 0005 already named.
- `docs/adr/0032-no-built-in-sandbox.md` deletes the supervisor, the proxy, the host prompt, and the SDK contract. This spec does not restore them. Containment of the whole session stays the operator's job.
- `docs/adr/0005-sandbox-boundary-guarantees.md`, superseded by ADR 0032, rejected a bash-only wrapper because it would leave native file tools, extensions, and later child processes outside a boundary that claimed to cover the session. A shell-only feature is allowed only if the spec and the README say that limit in those words.
- ADR 0004 still decides whether the call may run. Confinement runs only after the gate allows the call. It is not a second classifier and it cannot widen a denial.

## Current state

`bash` runs as a child of the session process, with the account's permissions, after the permission gate. There is no filesystem jail and no host allowlist. The README tells the user to run Docker, a VM, or a dev container for isolation.

## The problem

A user who trusts the gate but not a particular command has no middle setting. They can allow the command, or they can move the whole CLI into a container. The other CLIs offer a third choice for the shell only. Apex Code cannot document that choice honestly until the helper exists, and it must not document it as a replacement for the container.

## Goals

- [ ] `bash.confinement` defaults to `"off"`. `"off"` is today's behavior.
- [ ] `"on"` wraps the bash child with the platform helper. On Linux the helper is `bwrap`, already on the machine. On macOS the helper is `sandbox-exec`. On Windows the setting is refused with a message that names the platform, and the call does not run unconfined.
- [ ] The helper is not downloaded and is not shipped in the package. A missing helper refuses the call with the helper name. It does not fall back to an unconfined command.
- [ ] The confined command can read and write the workspace. It cannot read `~/.ssh`, `~/.aws`, or the agent directory. The test uses a scratch workspace and a canary file outside it.
- [ ] Network is denied except hosts listed in `bash.confinementHosts`. The list defaults to empty, which means no network. Loopback is allowed so a command can reach a server the session started.
- [ ] The README says the confinement covers `bash` only. It names `read`, `grep`, `find`, `ls`, and extensions as outside it. It still tells the user to use a container for an untrusted repo.
- [ ] No supervisor process, no egress proxy, and no host approval prompt. A refusal is tool text.

## Non-goals

- [ ] Reverting ADR 0032, or restoring Bubblewrap as a session-wide backend, Seatbelt as a session-wide backend, the supervisor, or the proxy.
- [ ] Confining `read`, `grep`, `find`, `ls`, `edit`, `write`, or extension processes. ADR 0005's objection stands for any text that claims those are covered.
- [ ] A new permission mode, a new rule source, or a prompt that asks the user to widen the host list mid-command.
- [ ] Windows support. The setting is refused there until a helper exists, which is a later spec.
- [ ] Claiming the result is safe against a kernel bug, a helper bug, or a command the gate already allowed to run outside the workspace.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Setting | `bash.confinement` is `"off"` or `"on"`. `bash.confinementHosts` is a list of hostnames. Both are user settings. A project settings file cannot turn confinement off. It may only add hosts when the user setting is already `"on"`. | `packages/coding-agent/src/core/settings-manager.ts` |
| Wrap | After the gate allows a foreground bash call, build the helper argv. Linux uses `bwrap` with a bind of the workspace and `--unshare-net` unless the host list is non-empty. macOS uses a Seatbelt profile written to a temporary file for that call. | `packages/coding-agent/src/core/tools/bash-confinement.ts` |
| Fail closed | `which`-style lookup of the helper. Missing helper returns the refusal and does not spawn the command. | same file |
| README | One paragraph. Off by default. Covers bash only. Container still required for an untrusted repo. | `README.md` |
| ADR | A new ADR records that this is a bash-only option, names what it does not cover, and says it does not supersede ADR 0032. | `docs/adr/0038-optional-bash-confinement.md` |

The host allowlist is a later slice if the first slice cannot do it without a proxy. The first slice may ship with network denied entirely, including no host list, and the goals above stay unchecked until the allowlist exists. Loopback stays allowed in that first slice.

## Deletion inventory

Nothing is removed. The README paragraph that says the user supplies a container stays. A sentence is added so the new setting is not read as a replacement.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Docs call the setting a sandbox and users trust it for `read` of `~/.ssh` | high | A secret leaves through a tool this spec does not wrap | The README lists the tools that are outside it, and the ADR repeats the ADR 0005 objection |
| `bwrap` is present but user namespaces are disabled, so the helper fails open somewhere else | medium | A command runs with more access than the user asked | The call is refused when `bwrap` exits non-zero before the command, and the test covers a missing helper |
| A project settings file turns the setting off under a user who turned it on | medium | The protection disappears in one repo | Project settings cannot set `"off"`. The user file is the only place that can. |

## Verification

- Setting test. Omitted means off. A project file with `"off"` does not override a user file with `"on"`.
- Missing-helper test. The wrap returns the refusal and the command function is not called.
- Linux test, skipped when `bwrap` is absent. A command that reads a canary outside the scratch workspace fails. A command that writes inside the workspace succeeds. The test does not use this repo as the workspace.
- README test, or a docs check if one already scans for the phrase. The new paragraph contains `read`, `grep`, `find`, `ls`, and `container`.

## Rollout

Default off. No session-format change. The ADR is written in the same change as the setting, not after.
