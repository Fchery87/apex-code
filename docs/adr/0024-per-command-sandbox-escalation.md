# ADR 0024 — Per-command escalation runs a second child, never widens the first

**Status:** Accepted · **Date:** 2026-08-28

ADR 0005's 2026-08-28 amendment delivered network escalation and explicitly did not
deliver the filesystem half, because the two refusals are not symmetric. A refused host is
refused by a userspace proxy Apex owns, which can hold the CONNECT open while a human
decides. A refused write is refused by the kernel: the syscall has already failed by the
time anything could ask, and a `bwrap` mount namespace is fixed for its lifetime, so
nothing inside the boundary can widen it afterwards.

**An approved command therefore runs in a second, separately mounted child, spawned by the
supervisor. The session's own namespace is never modified.**

This is what makes escalation sound rather than a hole. Approving one command grants
nothing to the session that asked: its next attempt at the same operation is refused
exactly as before, which the Linux backend's test asserts as a third step after the
escalated command succeeds. There is no accumulating authority, and no moment where the
boundary the session runs under is different from the one it started with.

Both children derive their argv from one builder, `core/sandbox/bwrap-arguments.ts`.
Two hand-maintained argv builders is the divergence ADR 0010 exists to prevent for tool
contracts, and it would be worse here: a mount tightened in the session child and missed
in the escalated one would be invisible until the escalated path was the one that
mattered. Everything that differs between the two is an input to that function.

The escalated child is deliberately smaller than the session's. It gets no network relay,
no credential channels, and no terminal handoff, because an escalated command is a single
shell invocation a human just read and approved, not a session; every channel omitted is
one it cannot reach. Its stdio is captured rather than inherited, so its output returns to
the session that asked instead of drawing over the TUI.

Nothing is remembered. Unlike a host or a credential, each request is asked about
individually, because a command is not a stable subject to grant against and a remembered
approval would silently cover the next command that named the same root. Approval is the
supervisor's under ADR 0023, so without a terminal the channel refuses outright and
headless, print, JSON, and RPC keep ADR 0005's deny.

The path in the request is a guess parsed out of the failed command's output, and it is
allowed to be, because nothing safe rests on it. The supervisor shows the human the exact
command and the exact root before anything runs, so a bad guess is refused by someone
reading it rather than granted quietly. When no path can be parsed, no escalation is
offered and the command fails as it did before. The parse is a convenience that saves the
user working out which directory to name; it is not a security control, and it is not
relied on as one.

Consequences accepted. An escalated command runs with authority the session does not have,
which is the entire point and is why it is announced, individually approved, and audited by
command and root in the supervisor's violation tail. macOS carries the same design through
`sandbox-exec` with a second profile, so the two backends do not diverge on what escalation
means. This ADR does not authenticate the escalation socket's peers; ADR 0023 explains why
that is unnecessary given the supervisor owns the decision, and why it would be
insufficient on its own.
