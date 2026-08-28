# ADR 0023 — Escalation authority belongs to the supervisor, not the child

**Status:** Accepted · **Date:** 2026-08-28

ADR 0005 deferred interactive escalation "until supervisor/child IPC can carry a concrete
blocked-host request without granting an unrestricted retry." That IPC now exists in
`core/sandbox/rpc/`, shipped on 2026-08-22 for credential writes. This ADR settles the
question ADR 0005's sentence left open, which turns out to decide whether escalation is
sound at all: **the channel says who may ask, and this ADR says who may decide.**

**The supervisor decides. It renders the approval prompt and reads the answer from
`/dev/tty` itself. No approval assertion originating inside the boundary is honoured.**

The reason is a property of the existing channel rather than a hypothetical. The
credential socket performs no peer authentication. It is bind-mounted at a fixed path in
the child's mount namespace, and every descendant in that namespace can connect to it.
ADR 0015's amendment enumerates what does constrain that channel — literal secrets only,
validated and byte-bounded frames, an audited tail, a supervisor-held file lock — and peer
identity is deliberately not among them. For credential writes that is a defensible
trade: the worst outcome is a literal secret written into a file the child already reads.

Host escalation is not that. A channel of the same shape carrying "the user approved
github.com" would be indistinguishable, at the supervisor, from the same frame sent by a
postinstall script, a git hook, a test fixture, or repository content steering the agent —
which is precisely the code ADR 0005 built the boundary to contain. A forgeable grant is
not a narrower boundary; it is an advisory one. Neither more auditing nor a narrower grant
shape repairs this, because the defect is in who is believed, not in what is asked for.

It follows that the child cannot prompt either. A prompt rendered by the child, whose
answer returns over the same unauthenticated channel, is evidence of nothing. The child's
only role in escalation is to stop drawing when asked, so the supervisor's prompt is
legible. A forged "suspend" frame therefore buys an attacker nothing: the human must still
type at a prompt the supervisor owns and reads. A child that refuses to yield the terminal
produces an unreadable prompt, not a grant. The failure mode is legibility, never
authority.

Consequences accepted. Escalation is unavailable wherever the supervisor has no
controlling terminal, which keeps ADR 0005's deny behaviour for headless, print, JSON, and
RPC modes as originally specified, now for a structural reason rather than a deferral. The
supervisor must read the terminal directly rather than through the child, so the two
coordinate over the channel for rendering and never for authority. A granted host lasts
for the session and is never persisted; a durable entry remains an explicit edit to global
settings, per ADR 0016.

This ADR does not authenticate the credential channel's peers, and does not claim the
credential channel needs it. It records why escalation cannot reuse that channel's trust
posture, and fixes the asymmetry in the one place it matters.
