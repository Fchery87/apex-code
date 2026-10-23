# ADR 0038 — Optional bash confinement does not restore the sandbox

**Status:** Accepted · **Date:** 2026-10-23

A user may set `bashConfinement` to `"on"` in the user settings file. A bash call then runs inside `bwrap` when that binary is on `PATH`. A missing binary refuses the call. The command does not run unconfined. This ADR does not supersede [ADR 0032](0032-no-built-in-sandbox.md).

## Decision

The setting defaults to off. Only the user settings file can turn it on. A project settings file cannot turn it on, and it cannot turn it off under a user who turned it on.

The wrap covers the `bash` tool. It does not cover `read`, `grep`, `find`, `ls`, `edit`, `write`, or extension processes. [ADR 0005](0005-sandbox-boundary-guarantees.md) rejected a bash-only wrapper because those tools would sit outside a boundary that claimed to cover the session. This ADR repeats that limit. Any text that calls the setting a sandbox for the session is wrong.

The helper is the `bwrap` already on the machine. Apex Code does not download it and does not ship it. On Windows the setting refuses the call and names the platform. There is no supervisor, no egress proxy, and no prompt that asks the user to widen access mid-command.

Network is denied with `--unshare-net`. A host allowlist is not built. Loopback is not specially allowed in this version, because `--unshare-net` denies it too.

## Why

ADR 0032 removed the OS sandbox because the prompt was friction, the maintenance cost was high for one maintainer, and a container already gives the user a real boundary. The other coding CLIs still confine the shell itself, off by default, and fail closed when the helper is missing. That is a smaller feature than the sandbox this ADR refuses to restore.

## Consequences

- A user who turns the setting on and has no `bwrap` gets a refusal instead of a command.
- A user who turns the setting on and has `bwrap` gets the helper argv. The command can write the workspace. It cannot use the network.
- `read` of `~/.ssh` is unchanged. The setting does not touch that tool.
- Reversal of ADR 0032 remains a separate, larger decision. This ADR is not the start of that reversal.

## Rejected alternatives

**Restore the supervisor, the proxy, and the session-wide Bubblewrap backend.** That is ADR 0032 in reverse. The reasons in that ADR still hold.

**Let a project settings file turn the setting off.** A repo the user has not reviewed could remove the protection the user asked for. The user file is the only switch.

**Document the setting as a sandbox.** The README names the tools it does not cover and still tells the user to use a container for an untrusted repo.
