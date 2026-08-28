# ADR 0005 — Sandbox boundary guarantees and supported platforms

**Status:** Accepted · **Date:** 2026-08-12

Phase 2a authorizes tool calls, but an authorization decision does not confine an
allowed tool or its subprocesses. Phase 2b therefore places the normal Apex runtime
and its complete child-process tree inside an OS sandbox. The initial Linux backend invokes Bubblewrap directly behind an Apex-owned
supervisor. This keeps the boundary's mounts, lifecycle, diagnostics, and evidence
semantics under Apex control rather than promoting the existing beta sandbox-runtime
example, whose bash-only shape and Linux violation limitations do not meet this ADR.
A later macOS backend may use Seatbelt (`sandbox-exec`) only after native integration
proof. The unsandboxed supervisor starts the normal Apex CLI as a sandboxed child. The child owns
its TUI, session, tools, extensions, and descendants; the supervisor owns teardown. This whole-CLI launch shape is mandatory: wrapping only the
`bash` tool would leave native file tools, extensions, and future child processes
outside the claimed boundary.

**The initially supported security boundary is the Linux Apex child-process tree.**
macOS remains a Phase 2b follow-up only after native integration proof; Windows is
unsupported. On an unsupported or incompletely provisioned host, Apex reports `not
enforced` and refuses to start an agent session rather than silently running it
unsandboxed.
The initial policy mounts the workspace read/write, only necessary runtime/toolchain
paths read-only, and private temporary/state paths; it denies host-home and normal
credential/session directories unless a later reviewed policy explicitly supplies
one. It denies all direct outbound network. Proxy-mediated allowlists are deferred
until their proxy bridge, DNS/IP semantics, and OS integration evidence exist.

The boundary is deliberately not described as a complete machine, account, VM, or
container security boundary. It cannot protect against kernel, Bubblewrap, Seatbelt,
proxy, or dependency vulnerabilities; administrator/root processes; an
already-compromised host; data or credentials deliberately mounted into the child; or
data sent to an allowed host. Hostname allowlisting is proxy policy, not a claim about
DNS rebinding, IP literals, UDP, arbitrary Unix sockets, or allowed endpoints being
benign; unsupported forms are denied rather than assumed safe. These limits are
surfaced in documentation and runtime diagnostics rather than obscured by a generic
"sandboxed" label.

A sandbox refusal is recorded in Apex Code's own bounded, per-session violation store
with a timestamp, operation (`filesystem` or `network` when detectable), command,
and human-readable detail. The OS/runtime's native violation feed is additionally
preserved where available. Interactive escalation is deferred until supervisor/child
IPC can carry a concrete blocked-host request without granting an unrestricted retry;
headless, JSON, print, and RPC behavior is deny. Persisted policy and a broad
sandbox-settings surface are likewise deferred until the whole-process boundary has
platform integration coverage; an opt-out is not introduced in Phase 2b.

Consequences accepted: this is a launch-architecture change and requires documented
host dependencies. It is preferable to silently substituting a best-effort Node path
check or a bash-only wrapper for an OS boundary that claims to cover Apex tool
execution.

## Amendment (2026-08-12): proxy bridge feasibility evidence

This ADR deferred proxy-mediated host allowlisting until "its own reviewed bridge
and OS integration evidence" existed. That evidence now exists — see the amendment
in `docs/specs/2026-08-12-os-sandbox.md`. A prototype confirmed a Unix-domain-socket
relay through the existing, unchanged `--unshare-net` isolation: the child keeps
zero network interfaces beyond loopback (verified with a real `bwrap` child, whose
direct outbound connect attempt failed with `Network is unreachable`), while the
supervisor's allowlist proxy is reachable only via a bind-mounted Unix socket, not a
network path. This needs no new privileged primitive and no new runtime dependency —
an alternative using a veth pair between nested unprivileged network namespaces was
prototyped and rejected because it would have required `pasta` or `slirp4netns` as a
new dependency to bootstrap connectivity, for no isolation benefit over the socket
relay.

This amendment records feasibility only. It does not change this ADR's decision to
ship deny-all network first, and it does not itself authorize implementation —
DNS/CONNECT handling, the allowlist config surface, violation-store wiring, and
integration test coverage remain open and are tracked in the Phase 2b spec and
plan, not settled by this ADR.

## Amendment (2026-08-12, second): macOS design spike — not empirically validated

A design for a macOS backend (Seatbelt via `sandbox-exec`, mirroring the Linux
`SandboxBackend` shape) is recorded in the 2026-08-12 fourth spec amendment. Unlike
the Linux proxy-bridge amendment above, **this one is desk research, not a
prototype** — this development environment has no macOS host, so nothing was run.

One finding from that research changes what this ADR can claim if a macOS backend
ships: **macOS has no primitive equivalent to Linux's network namespace.** The
Linux boundary's "no route to fall back on" guarantee rests on the child's network
namespace having zero interfaces beyond a loopback private to that namespace.
macOS's `localhost` is the shared host loopback every process on the machine can
already reach; a Seatbelt rule permitting the sandbox proxy's port narrows the
child to that port but cannot make the port private to the child. A macOS backend
would therefore carry a real, categorically weaker network guarantee than the
Linux backend does, not an equivalent one implemented with different syntax. This
ADR's boundary-guarantees language is Linux-specific until a macOS amendment states
its own, separately, once the design is validated on real hardware.

macOS remains gated on native integration proof, per this ADR's original text and
the roadmap. This amendment does not lower that bar — it records what the paper
design would claim and flags where that claim would need to be weaker than
Linux's, so the eventual native validation is scoped to close a known gap rather
than discover it.

## Amendment (2026-08-13): macOS prototype ran — the gap above is confirmed, not resolved

A real `sandbox-exec` prototype ran on `macos-latest` CI (macOS 26.5.2). See the
2026-08-12 spec's fifth amendment for the full record. Two results worth stating
here directly: pinning a Seatbelt network-outbound rule to one exact localhost
port **does** genuinely exclude a different local port — confirmed by a real
`EPERM`, not assumed — so the design in the prior amendment is not merely
theoretical. And the Linux-style Unix-domain-socket relay, which might have closed
the shared-loopback gap entirely, does **not** work on macOS as tested: Seatbelt's
`(deny network*)` gates `AF_UNIX` connections too, not just `AF_INET`.

Neither result changes this ADR's core finding: macOS has no primitive equivalent
to a private, per-process network namespace, so a macOS backend's network
guarantee remains categorically weaker than Linux's "no route exists at all" —
port-pinning narrows the shared-loopback exposure, it does not eliminate the
category. macOS remains gated on native integration proof for an actual
implementation task; this amendment narrows what that task still needs to prove,
it does not stand in for it.

## Amendment (2026-08-13): macOS backend implemented and verified on real hardware

The native integration proof this ADR required now exists. `core/sandbox/
macos-backend.ts` is a real, shipped `SandboxBackend`, verified with 238 test
files / 2112 tests passing, 0 failed, on `macos-latest` CI (macOS 26.5.2) — see
the 2026-08-12 spec's sixth amendment and the plan's 2b.5 record for the full
account, including five real bugs the prototype amendment's paper design did not
anticipate (missing `process-exec*`/`process-fork` allows, unresolved symlinks in
`subpath` matching, a missing `spawn()` `cwd`, and a read-only allowlist that
broke ordinary process startup and had to be replaced with Linux's actual
broad-read/narrow-write posture: `(allow file-read*)` plus an explicit deny on the
invoking account's home directory, not a read allowlist).

**This ADR's guarantee language is now backed by two enforced backends, not one.**
The categorical gap recorded in the prior amendment stands exactly as written:
macOS's network guarantee is real (a blocked port genuinely gets `EPERM`, not a
theoretical claim) but remains weaker than Linux's, because macOS has no private
per-process loopback. Apple Events/Launch Services denial and code-signing
behavior for a distributed (not locally-built) binary are not yet addressed and
are not claimed as covered by this amendment. Windows remains unsupported,
unchanged.

## Amendment (2026-08-13, second): Linux's own guarantee now actually checked by CI

A gap surfaced while landing the macOS backend: `ubuntu-latest` never had
`bubblewrap` installed, so this ADR's Linux guarantee — the one both backends are
now measured against — had never itself run in CI. Root cause was a GitHub-hosted
runner default (Ubuntu 24.04's AppArmor unprivileged-userns restriction, not a
flaw in this repo's design), fixed with one `sysctl` line before `bwrap` runs. See
the 2026-08-12 spec's third 2026-08-13 amendment and the plan's 2b.7 record. This
does not change what this ADR claims — it closes the gap between what was claimed
and what CI actually verified.

## Amendment (2026-08-28): interactive network escalation is no longer deferred

This ADR deferred interactive escalation "until supervisor/child IPC can carry a concrete
blocked-host request without granting an unrestricted retry." That prerequisite was met on
2026-08-22 by `core/sandbox/rpc/`, built for supervisor-mediated credential writes
(ADR 0015's amendment) — ten days after this ADR was accepted, and by work that had no
reason to notice it was also unblocking this. The deferral outlived its own condition.

Escalation now ships for the network layer, and the shape this ADR asked for is what
landed. A refusal carries one concrete host and port. A grant covers that host and port and
nothing else, lasts for the session, and is never persisted; a durable entry remains an
explicit edit to global `network.allowedHosts`, per ADR 0016. Declining is not remembered,
so a later attempt asks again rather than presenting a cached refusal as policy.
Concurrent connections to the same refused host coalesce onto one question. Nothing grants
an unrestricted retry.

**Headless, print, JSON, and RPC behaviour is unchanged and remains deny**, now for a
structural reason rather than a deferral: the approver is constructed only when the
supervisor holds a terminal, and its absence leaves this ADR's original
deny-without-asking path running untouched. There is no mode check to forget.

One decision inside this work was large enough to need its own record.
`docs/adr/0023-supervisor-owned-escalation-authority.md` establishes that the supervisor,
not the child, renders the prompt and reads the answer, because the credential channel
performs no peer authentication and an approval asserted from inside the boundary would be
forgeable by exactly the code this boundary exists to contain. This amendment does not
restate that reasoning; it depends on it.

Filesystem escalation remains deferred and is **not** delivered here. A refused write is
refused by the kernel inside a namespace whose mounts are fixed for its lifetime, so there
is no in-place equivalent of holding a CONNECT open while a human decides. That gap and a
proposed shape for it are recorded in
`docs/specs/2026-08-28-sandbox-delegation-and-escalation.md`, not settled by this
amendment.
