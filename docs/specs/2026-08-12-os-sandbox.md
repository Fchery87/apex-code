# Spec: OS sandbox boundary

## Metadata

| Field | Value |
| --- | --- |
| Author | Fchery87 |
| Status | `Active` |
| Created | 2026-08-12 |
| Last updated | 2026-08-12 |
| Roadmap phase | 2b — Permissions (OS sandbox) |
| Tracking issue/PR | none |
| Compatibility posture | **Deliberate behavior change with no compatibility shim for agent sessions.** On supported hosts, Apex Code starts its normal runtime as a sandboxed child process tree: writes outside the workspace and all unallowed outbound hosts fail. On an unsupported or incompletely provisioned host, an agent session fails closed rather than falling back to prior unsandboxed behavior. Linux is the initial supported backend; macOS is added only after native integration proof, and Windows remains unsupported. This pre-1.0 alpha security change is intentional; a silent fallback would falsely imply the same protection. Existing session/config formats remain unchanged. |

## Executive summary

Phase 2b adds an OS-enforced sandbox around the normal Apex CLI child process, so
native file tools, bash descendants, and in-process extensions share one boundary.
The first delivery supports Linux through Bubblewrap with an isolated, deny-all network
namespace. Proxy-mediated host allowlisting is deferred until it has its own reviewed
bridge and OS integration evidence. macOS Seatbelt support is a follow-up task inside
this phase only after native integration proof. The boundary records Apex-owned
violations and fails closed if its supported backend cannot start.

## Context and motivation

- `docs/roadmap.md` Phase 2 requires a sandbox to block one write outside the
  workspace and one request to a non-allowlisted host, surfacing both as violations.
- `docs/adr/0004-permission-rule-model.md` provides authorization at
  `beforeToolCall`; it explicitly is not an operating-system boundary.
- `docs/adr/0005-sandbox-boundary-guarantees.md` settles the enforceable boundary,
  the supported platforms, and the non-guarantees before implementation.
- `packages/coding-agent/src/cli.ts` is the launch seam, and
  `packages/coding-agent/src/main.ts` owns runtime/session construction.
- `packages/coding-agent/examples/extensions/sandbox/` demonstrates the existing
  sandbox-runtime API, but wrapping only bash is insufficient: native file tools,
  extensions, and in-process execution remain outside it. It has no Apex-owned
  lifecycle, diagnostics, or test contract.

## Current state

Phase 2a passes all registered calls through `PermissionGate`, but the normal Apex
process and every tool within it hold the invoking user's authority. The production
CLI has no sandbox supervisor. The bundled sandbox extension can initialize
`SandboxManager`, but wraps only bash, defaults to a broad write list, and can disable
itself after initialization failure; it does not govern native file tools, extensions,
or all child processes.

## The problem

A permission allow or interactive approval controls whether a command starts, not what
the command and descendants do afterward. For example, a command initially approved
for a workspace action can write to an account path or contact an unrelated host. A
Node-level parser cannot reliably mediate descendants, shell expansion, or arbitrary
network clients. The product currently offers no OS-level containment and no durable
record that a lower boundary rejected an operation.

## Goals

- [ ] On Linux with prerequisites installed, the normal Apex CLI, its native tools,
      extensions, bash commands, and descendants run in one OS-sandboxed child
      process tree. macOS is enabled only after an equivalent native integration test.
- [ ] The default policy permits writes within the session workspace, rejects a write
      outside it, and records a structured filesystem violation.
- [ ] The default policy has an empty network allowlist; an attempted unallowed host
      is rejected and recorded as a structured network violation.
- [ ] Unsupported platforms or missing prerequisites are visible `not enforced`
      diagnostics and block agent-session startup; no route executes the normal CLI
      unsandboxed under a claimed sandbox mode.
- [ ] Supervisor lifecycle cleanup terminates sandbox proxy resources after the child
      exits and does not leak them across process invocations.
- [ ] Boundary-level integration tests execute a sandboxed child and prove the
      roadmap's filesystem and network exit cases, including a grandchild process.

## Non-goals

- [ ] Sandboxing the supervisor/host process, provider requests performed by the
      supervisor, or external programs started outside the child. This is not a VM or
      host account boundary.
- [ ] Windows support. The chosen runtime does not support it; introducing a weaker
      alternative would invalidate a single security claim.
- [ ] Interactive escalation, persisted user/project allowlists, or an escape hatch.
      A host-child IPC protocol and reconfiguration model must be designed before an
      approval can safely permit a blocked request.
- [ ] Claiming host, kernel, administrator, dependency, DNS/IP/UDP/Unix-socket, or
      allowed-destination compromise resistance. ADR 0005 enumerates non-guarantees.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Sandbox abstraction | Add a typed Apex-owned supervisor facade with preflight, status, launch, cleanup, and a bounded violation store. | new `core/sandbox/` |
| Linux platform adapter | Invoke Bubblewrap directly with a workspace-only write mount and a deny-all isolated network namespace, then wrap a normal CLI child. Proxy-mediated host allowlisting is deferred. | new `core/sandbox/linux-backend.ts` |
| CLI launch | The public entry starts a distinct internal child entry under the supervisor with inherited stdio; the child cannot recursively supervise itself. | `cli.ts`, new launcher module |
| Child environment | Supply only explicit workspace, private temporary/state, and required runtime/toolchain mounts; do not mount host home/credential/session directories by default. | platform adapter / supervisor |
| Violations | Record known runtime rejections and native monitor entries in Apex's bounded store; transmit only structured events across the supervisor boundary. | new `core/sandbox/violations.ts` |

The `beforeToolCall` gate remains inside the child: authorization prevents tool work,
while the outer sandbox constrains every allowed operation afterward. This preserves
one authority decision and one OS boundary rather than creating a special bash route.
The public entry uses a distinct internal child entry rather than an environment
sentinel. No child environment variable is accepted as proof of enforcement or shown
as a claimed-enforced status.

## Deletion inventory

Nothing existing is removed. The direct host-process launch is superseded by the supervisor/child launch for a
normal agent session. Tool interfaces remain unchanged, because their process has
already been confined before they execute.

## Risks

| Risk | Signal | Mitigation |
| --- | --- | --- |
| Host lacks Bubblewrap | startup diagnostic and agent-session refusal | dependency probe before supervisor launch; document package prerequisite |
| Supervisor lifecycle leaks across runs | child or future bridge resources remain after exit | one supervisor owner; idempotent cleanup |
| Native runtime cannot identify a Linux filesystem rejection | violation test lacks operation/path | record an Apex execution refusal fallback with raw sandbox output; do not fabricate a path |
| Network namespace escape | child reaches a blocked test host directly | isolated network namespace plus direct TCP refusal test |
| Recursive launch weakens containment | public child starts another supervisor | a separate internal child entry imports `main()` directly |
| Misleading scope | docs/UI imply native tools or host process are confined | ADR 0005 non-guarantees copied into public diagnostics/help |

## Verification

- Unit tests construct the supervisor facade with a fake backend and cover preflight,
  child-entry routing, fail-closed status, and violation normalization.
- Linux/macOS integration tests are conditionally skipped only when their documented
  system prerequisites are absent, reporting the reason; on supported CI they launch
  a real sandboxed child in a scratch directory.
- The integration tests assert a child/grandchild `sh -c 'echo x > outside'` cannot
  create the outside file and adds a filesystem violation, and a request to a local
  test host absent from the allowlist fails and adds a network violation.
- `test/permissions/gate-universal.test.ts` remains green to prove sandboxing did not
  create a route around the permission choke point.
- Run `npx tsgo --noEmit`, focused sandbox/bash tests, `npm run build`, then `npm test`.

## Rollout

Needs `docs/plans/2026-08-12-os-sandbox.md`: it crosses package distribution,
platform-dependent execution, lifecycle management, diagnostics, and real OS
integration tests. ADR 0005 is required and has been accepted before implementation.

## Amendment (2026-08-12): network allowlist feasibility spike

Deny-all network (`--unshare-net`, tasks 2b.1–2b.4) is shipped and correct, but it
means an online agent session cannot reach its model provider. ADR 0005 explicitly
deferred a proxy-mediated allowlist until it had "its own reviewed bridge and OS
integration evidence." This amendment records that evidence. **It is a design
finding, not an implementation** — no production code changed; tasks 2 (violation
evidence wiring), 3 (live-agent boundary test), and 4 (CLI suite reconciliation)
from the originating review remain future work, tracked separately from this spec.

**Options considered:**

1. **veth pair between two unprivileged-nested network namespaces, proxy on the
   host-side end.** Prototyped and confirmed working (see evidence below): an
   unprivileged `unshare --user --net --map-root-user` owns a user namespace `U`;
   a second `unshare --net` inside it creates a sibling namespace also owned by
   `U`; a veth pair created in one can be moved into the other (`ip link set
   veth1 netns <pid>` succeeds). Moving a device from a namespace owned by `U`
   back into the *true* host namespace (owned by `init_user_ns`) fails with
   `Operation not permitted` — confirming real root is required to bridge a
   custom-userns network namespace back to the host's, which is exactly the
   problem tools like `slirp4netns`/`pasta` exist to solve via TAP-fd-passing
   rather than device migration. Rejected as the final design: it would add
   `pasta` or `slirp4netns` as a new runtime dependency (neither is installed
   today) purely to bootstrap connectivity for a component that doesn't need a
   real IP stack at all — see option 2.
2. **Unix domain socket relay through the existing fully-isolated netns
   (recommended, prototyped, and confirmed working).** Keep today's
   `--unshare-net` unchanged — the child keeps zero network interfaces beyond
   loopback, exactly as already shipped. The supervisor (already unsandboxed,
   already network-capable) runs an HTTP CONNECT allowlist proxy listening on a
   Unix domain socket instead of a TCP port. That socket's containing directory
   is bind-mounted read-write into the child alongside its existing workspace/
   temp mounts. A UDS is filesystem-scoped, not network-namespace-scoped, so it
   is reachable from inside a fully net-isolated child without any veth,
   namespace nesting, or new dependency. A small relay process, started inside
   the child's own namespace tree (same net/pid confinement as the agent
   itself), listens on the child's private `127.0.0.1:<port>` and pipes bytes to
   the UDS, so `HTTP_PROXY`/`HTTPS_PROXY` work unmodified for any HTTP client —
   Node, git, curl, or an arbitrary native binary — not just a custom Node
   dispatcher. Chosen because it needs no new external dependency, no privilege
   beyond what `--unshare-net` already uses, and is additive to the shipped
   tasks 2b.1–2b.4 rather than a replacement of them.

**Why the OS-level guarantee holds regardless of app cooperation:** the relay's
loopback listener is a convenience for clients that honor proxy env vars. The
actual boundary is that the child's network namespace has no interface capable of
reaching anything but its own loopback — confirmed below by a direct-connect
attempt from inside a real `bwrap --unshare-net` child failing with `Network is
unreachable`, not a timeout or a policy-level refusal. A process that ignores
`HTTPS_PROXY` and dials a hardcoded IP has nowhere to send the packet; there is no
route to fall back on.

**Prototype evidence** (ad hoc scripts, not committed — this session's
scratchpad only):

- `unshare --user --net --map-root-user` → `ip link add veth0 type veth peer name
  veth1` succeeds; a second `unshare --net` inside the same user namespace
  creates a sibling namespace; `ip link set veth1 netns <sibling-pid>` succeeds
  (`MOVE_RESULT=SUCCESS`). The same move attempted back into the true host
  namespace fails: `RTNETLINK answers: Operation not permitted`.
- With the sibling-netns veth wired up (`10.200.7.1` supervisor side,
  `10.200.7.2` child side, default route via `.1`, host `ip_forward=0`): the
  child side reaches a listener on `10.200.7.1:8899` (`PROXY_REACHABLE` /
  `PROXY_OK`) and cannot reach `1.1.1.1:443` (`DIRECT_INTERNET_BLOCKED`, an
  immediate no-route failure, not a hang).
- A real `bwrap --unshare-net` child (same isolation flags as today's shipped
  deny-all backend) with a host directory bind-mounted read-write reached a Unix
  domain socket listener in that directory (`CHILD_UDS_RESULT:
  b'ALLOWLIST_PROXY_OK\n'`) while a direct `AF_INET` connect from inside the same
  child to `1.1.1.1:443` failed with `[Errno 101] Network is unreachable`.

**Open work, not done in this session** (scoped separately, see roadmap Phase 2b):
DNS resolution ownership and CONNECT-request parsing in the proxy; the
`network.allowedHosts` config schema and its precedence against the existing rule
model; wiring proxy rejections into `core/sandbox/violations.ts`'s bounded store;
lifecycle/cleanup for the UDS and relay process; and an integration test proving
an allowed host succeeds and a non-allowlisted host fails closed with a recorded
violation, run from a scratch workspace per `AGENTS.md`.
