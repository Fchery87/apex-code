# ADR 0029 — Authorization and execution share one prepared path operation

**Status:** Accepted · **Date:** 2026-09-06

The permission gate decided one thing and the filesystem did another. `evaluateToolCall`
resolved a path to decide whether the call was allowed, and then `read`, `write`, `edit`,
`grep`, `find`, and `ls` each resolved the same user-supplied string again at execution
time. Two independent resolutions of the same string are two answers whenever the
filesystem changes between them, and the window between them is attacker-controllable:
replacing the authorized name with a symlink after the decision redirected the read or the
write to a file the gate never saw. Spec
`docs/specs/2026-09-05-security-boundary-remediation.md` records the finding.

**A tool's permission spec prepares one validated operation value at authorization time,
and execution consumes that value rather than re-deriving a target from the original
arguments. For path operations the value carries the canonical absolute path and the
target's device and inode, and execution opens no-follow and refuses any descriptor whose
identity does not match.**

Four properties are the decision.

**The prepared value travels on the object the loop already carries.** `prepareCall`
stores a `PreparedPathOperation` in a `WeakMap` keyed by the validated-arguments object.
`agent-core` passes that same object to `beforeToolCall` and then to
`executePreparedToolCall`, so authorization and execution hold the identical value by
construction rather than by a copy that could drift. This adds no hook and no agent-core
change, which is the same constraint ADR 0010 places on the gate itself.

**Identity, not the pathname, is what execution checks.** A canonical path is still a
name, and a name is what an attacker replaces. `preparePathOperation` records `dev` and
`ino` at decision time. `readPreparedPath` and `writePreparedPath` open the final component
`O_NOFOLLOW`, `fstat` the descriptor, compare it with the recorded identity, and only then
move bytes. Every directory component is walked `O_NOFOLLOW` under a single held directory
descriptor, so a swapped intermediate cannot be traversed either. A new file is created
`O_CREAT | O_EXCL | O_NOFOLLOW` at mode 0600, so a pre-placed file or symlink at the target
name aborts instead of being written through.

**The union has exactly two states and no third.** `path-existing` carries an identity;
`path-new` does not, because there is nothing yet to identify. A read against `path-new` is
refused rather than treated as an empty file. Making the missing-file case a separate
variant rather than an optional identity field is what stops "identity absent" from being
read as "identity matched".

**An operation class without a production caller is not declared.** An earlier draft
declared `BashOperation`, `CommandOperation`, `CredentialOperation`, and
`EvidenceOperation` alongside the path variants. None of them reached the gate or the
executor, so the type surface claimed a canonical operation model that the code did not
have. They were deleted. The model covers path operations, and a future class earns its
variant when a caller exists.

## Consequences

Descriptor-pinned execution covers `read`, `write`, and `edit`. `grep`, `find`, and `ls`
consume the gate-authorized canonical pathname but do not hold a descriptor, so an
intermediate directory swapped between authorization and execution remains a window for
those three. That is a known gap, recorded rather than implied.

The walked-descriptor chain needs `/proc/self/fd` to re-open relative to a held directory
descriptor. Where that is unavailable the final-component `O_NOFOLLOW` open and the
identity check still apply, but intermediate components are opened by pathname prefix. The
guarantee verified today is Linux-only.

Complete mediation holds when a permission gate is configured. The gate stays optional in
`AgentSessionConfig`, so an embedding that supplies none performs no authorization, by
design and not by accident. Any claim about mediation carries that clause.

New files created through the prepared write path are mode 0600. This is deliberate
hardening and a visible behavior change for anyone who expected the process umask.

Bash keeps a grammar-sensitive string matcher over parser-produced segments rather than a
typed operation. What changed there is the failure direction, not the representation:
unparseable grammar can no longer satisfy an allow rule, a deny matches any segment, and
quoted whitespace, newlines, comments, and escapes cannot reuse an approval granted for a
different command.

The configured-command authority (ADR 0030) reuses this boundary shape for its own typed
value rather than forcing verification and formatter commands into the path union.
