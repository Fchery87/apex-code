# ADR 0030 — Configured commands are authorized, and a formatter is confined by copy and restricted promotion

**Status:** Accepted · **Date:** 2026-09-06

ADR 0028 settled where verification and formatter policies come from and made the declared
`permission` a ceiling. It did not say who enforces that ceiling, or how a formatter is
held to its declared paths. Both answers turned out to be "nobody". `runPolicyCommand`
spawned whatever the policy named with no permission decision, so a `permission: "deny"`
policy still ran and plan mode did not stop a formatter from writing. The formatter ran
directly in the user's workspace and listed undeclared writes afterwards, which is a
report about bytes that are already on disk. Spec
`docs/specs/2026-09-05-security-boundary-remediation.md` records both findings.

**A configured command is authorized through the same authority a tool call uses, by a
second entry point rather than a second authority. A formatter runs against an isolated
copy of the workspace and only its declared changes are promoted back.**

Four properties are the decision.

**One authority, two entry points.** A tool call carries a tool name and a rule grammar,
so it reaches `resolvePermission`. A configured command has neither, so it cannot.
`authorizeConfiguredCommand` therefore skips rule resolution but calls the same
`resolveWithMode`, which means plan mode's `exec` and `fs.write` floor and the
`bypassPermissions` escape hatch behave identically for a formatter and for the write
tool. This is deliberately not a parallel policy engine; a second engine is the drift ADR
0010 exists to prevent.

**The declared permission is a ceiling that no mode raises.** A `deny` policy is refused
before the mode is consulted at all. `bypassPermissions` lowers an `ask` but cannot lift a
`deny`, because the policy permission belongs to whoever wrote the configuration and a
runtime mode is not that person. An approved `ask` persists no rule, since there is no
tool name to persist against; the approval covers that run only.

**Confinement is an isolated copy with restricted promotion, and post-hoc detection is not
confinement.** The workspace is materialized into a private stage directory, the formatter
runs there, the stage is diffed, and only changes matching the declared paths are written
back through the ADR 0029 no-follow write. An undeclared write is discarded with the stage
and never reaches the workspace. `PolicyRunStatus` gains `scope-violated`, which maps to a
failed or interrupted verification outcome and can never present as `verified`.

**A concurrent edit is refused, never reverted.** Promotion compares each live file
against its pre-run fingerprint and refuses any file that changed during the run, marking
the run failed. Overwriting there would destroy work the user did while the formatter ran,
and reverting the workspace afterwards would do the same. Promotion also refuses any
target that canonicalizes outside the workspace, so a symlink planted at a promotion target
is not followed.

## Alternatives rejected

**OS-enforced per-path write restriction.** The honest mechanism would be a nested sandbox
started with only the declared paths writable. It cannot be erected from inside the
already-sandboxed child: nested unprivileged user namespaces are not projected and `bwrap`
is not present there. It is a supervisor and platform-backend concern, not a lifecycle one.

**A Git worktree as the boundary.** A worktree is a directory, not a confinement
primitive. A process running in one writes anywhere it likes.

**Reporting undeclared writes and reverting them.** This is what the code did, and it is
what the finding was. A revert cannot undo an external side effect, and by the time the
diff runs the bytes have already been readable.

**Making `runPolicyCommand` take a gate.** The executor stays a pure spawner. Adding a
required parameter would break its tests and every extension caller for no gain, since the
wrapper is where the decision belongs.

## Consequences

Copy and restricted promotion confine workspace mutation only. A formatter that writes an
absolute path outside the workspace still reaches it, and the stage diff cannot see that
write, so such a run still reports `passed`. Under the CLI the OS sandbox is what stops
this. An unsandboxed SDK embedding has no such boundary and must not be described as
though it did. `test/formatter-confinement.test.ts` carries this as a named limit case so
it cannot quietly become a false claim.

Materialization copies regular files only. A workspace symlink is not reproduced in the
stage, so a formatter cannot reach a link's target through it, and promotion does not
follow the live link either.

Every formatter run now costs a full workspace copy, bounded by the snapshot caps already
in place and skipping `.git`, `node_modules`, `.apex-code`, and `sessions`. Confinement is
not free and this ADR does not pretend it is.

A session without a permission gate authorizes nothing, and configured commands then run as
before. That is the documented SDK default, and ADR 0031 is where an embedder states what
containment it actually has.

## Amendment (2026-09-12): the CLI no longer has the OS backstop this ADR assumed

[ADR 0032](0032-no-built-in-sandbox.md) removed the OS boundary, which changes one
sentence in Consequences above and weakens one guarantee. This is the honest record of
both.

The sentence "Under the CLI the OS sandbox is what stops this" is no longer true. A
formatter that writes an absolute path outside the workspace now reaches it under the
CLI exactly as it does under an SDK embedding, and the stage diff still cannot see the
write, so the run still reports `passed`. The CLI and the embedding are now the same
case rather than two.

Copy and restricted promotion are unchanged and still do what this ADR decided. They
confine workspace mutation. They never confined absolute paths, and the ADR said so.
What is gone is the second layer that made the limit case narrow in practice.

The mitigation is the one [ADR 0032](0032-no-built-in-sandbox.md) names for everything
else. Run the CLI inside a container or VM when a configured command comes from a
repository you have not read. `test/formatter-confinement.test.ts` still carries the
limit case, and its comment is corrected to match this amendment rather than the
boundary it used to name.

The closing reference to ADR 0031 above is also superseded. An embedder no longer
states a containment contract to the SDK, because the SDK no longer has one to state.
What an embedder contains is now entirely a property of where it runs the process.
