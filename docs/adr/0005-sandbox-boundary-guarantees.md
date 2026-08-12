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
its TUI, session, tools, extensions, and descendants; the supervisor owns teardown
and the host-side proxy. This whole-CLI launch shape is mandatory: wrapping only the
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
one. It denies all direct outbound network and routes permitted HTTP/SOCKS traffic to
the supervisor proxy, whose allowlist initially has no hosts.

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
