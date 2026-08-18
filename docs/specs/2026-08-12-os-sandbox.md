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

### Amendment (2026-08-12, second): implementation landed — task 2b.4d

The design above was implemented against real code: `core/sandbox/network-proxy.ts`
(the supervisor-owned UDS allowlist proxy), a relay script written into the child's
state directory and run inside the unchanged `--unshare-net` isolation, and a
`network.allowedHosts` settings surface threaded from `cli.ts` through to the
backend. See `docs/plans/2026-08-12-os-sandbox.md` task 2b.4d for the full record,
including five review findings fixed after the initial commit (a non-portable
hardcoded test path, a fabricated violation message, debug output and scratch files
left in the commit, and added stale-socket hardening) and three known gaps carried
forward: double violation-recording for a single blocked connection, no port
dimension on the allowlist, and hostname-string equality rather than a resolved-IP
check at connect time.

### Amendment (2026-08-12, third): two of the three gaps closed — task 2b.4e

`linux-backend.ts` no longer records a generic fallback violation when the network
proxy already recorded a more specific one for the same launch, and
`allowedHosts` entries may now be `hostname:port` to pin an exact port (a bare
hostname still matches any port, unchanged). See task 2b.4e for the full record.
The resolved-IP-at-connect-time check remains open, not settled by this amendment.

### Amendment (2026-08-12, fourth): macOS feasibility spike — task 2b.5

**This is desk research, not a prototype, and that distinction matters more here
than it did for the Linux spike.** The Linux amendment above records commands
actually run and their actual output. This one does not — this development
environment has no macOS host, so nothing below was executed. Every claim is
sourced from Apple's own (unofficial — Apple ships no first-party docs for this
mechanism) profile grammar and from other credible, currently-shipping
implementations, cited inline. Treat this as a design proposal to validate on real
macOS hardware before task 2b.5 opens an implementation task, exactly as the Linux
spike was validated by prototype before task 2b.4d did.

**Options considered:**

1. **App Sandbox (`com.apple.security.app-sandbox` entitlement).** Rejected outright,
   not just deprioritized: it requires code signing and is designed for GUI apps
   distributed through the Mac App Store. An npm-distributed CLI binary has no
   Xcode project and no App Store distribution to entitle against.
2. **`sandbox_init_with_parameters` (native C API).** The API real sandboxed browsers
   use — Chrome, Firefox, and Nix all call it — but Apple has never published a
   header for it, and a 2026-05 issue on Apple's own `apple/containerization` repo
   asking for a supported non-App-Store process-sandboxing API remains open with no
   Apple response
   ([apple/containerization#737](https://github.com/apple/containerization/issues/737)).
   Consuming it would mean an undocumented native binding from Node with no upgrade
   guarantee across macOS versions. Rejected for now on engineering-cost and
   stability grounds, not ruled out permanently.
3. **`sandbox-exec` (recommended).** A thin CLI wrapper around the same underlying
   Seatbelt mechanism as option 2, deprecated by Apple alongside it but still
   functional on current macOS
   ([openai/codex#215](https://github.com/openai/codex/issues/215) and multiple 2025
   sources confirm it still works despite the deprecation warning). Chosen because
   it shells out exactly like `bwrap` already does — no native binding, no FFI, same
   spawn/wait/classify shape `linux-backend.ts` already has — and because Anthropic's
   own shipped `sandbox-runtime`
   ([anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime))
   uses exactly this mechanism in production today, which is the strongest
   available evidence that the deprecated primitive is still a viable foundation.
4. **macOS 26 "containers."** A new, unproven mechanism with no adoption evidence
   found. Noted as a possible future replacement, not the near-term path — the
   same reasoning that rejected option 2 (undocumented, unstable-across-versions
   surface) applies more strongly to something this new.

**Recommended design**, matching the existing `SandboxBackend` interface
(`core/sandbox/supervisor.ts`) so no other module changes shape — a new
`macos-backend.ts` sits alongside `linux-backend.ts` as a second platform adapter:

- **Filesystem.** Base the generated `.sb` profile on `(deny default)`, not the
  read-allow-by-default pattern some other implementations use for convenience.
  `(deny default)` denies reads and writes alike unless explicitly allowed —
  matching Linux's `--ro-bind / /` posture and ADR 0005's existing commitment that
  host-home and credential directories are denied unless explicitly supplied, not
  allowed-then-denied. Explicit `(allow file-read* file-write* (subpath
  (param "WORKSPACE")))` for the workspace, plus explicit read-only allows for the
  runtime/toolchain paths `linux-backend.ts`'s `readOnlyMountArguments()` already
  computes today (same ancestor-path logic, no macOS-specific change needed there).
- **Network.** `(deny network*)` base, then `(allow network-outbound (remote ip
  "localhost:<port>"))` scoped to the exact fixed port the existing
  `core/sandbox/network-proxy.ts` allowlist proxy binds — not the wildcard
  `localhost:*` pattern found in some published profiles (including, per available
  documentation, Anthropic's own and other agent-sandbox examples), to minimize (see
  below — not eliminate) the exposure that wildcard implies. `network-proxy.ts`
  gains a TCP-listen mode (`127.0.0.1:<port>`) alongside its existing UDS mode; on
  macOS no in-child relay script is needed at all — the Seatbelt profile permits the
  proxy's port directly, simpler than Linux's UDS-plus-relay design, because macOS
  can allow a specific network destination without an all-or-nothing interface
  decision the way an unshared network namespace forces.
- **Apple Events / Launch Services.** Explicitly deny these in the profile
  (`(deny appleevent-send)` and the Launch Services equivalent). Unlike Linux's
  `--unshare-pid`, Seatbelt's default profile does not automatically block a
  sandboxed process from asking the system to launch an arbitrary application —
  several other implementations found this necessary to close, not optional
  hardening.
- **Reused unchanged:** `core/sandbox/violations.ts` (already platform-agnostic) and
  the `SandboxBackend` contract itself. The new backend's shape mirrors
  `linux-backend.ts`: generate the profile per launch, `spawn("sandbox-exec", ["-f",
  profilePath, "-D", `WORKSPACE=${workspace}`, "-D", `PROXY_PORT=${port}`, "--",
  command, ...args])`, same `waitForExit`/stderr-classification pattern.

**The load-bearing honest finding, and the reason this cannot be waved through as
"the same design, different flag":** macOS has no primitive equivalent to Linux's
network namespace. The Linux boundary's strongest claim — proven by prototype in
the first amendment above — is that a direct-connect attempt from inside the child
has *no route to fall back on*, confirmed by a real `Network is unreachable` errno,
regardless of whether the calling process cooperates with `HTTPS_PROXY`. `localhost`
on macOS is not a private, per-process loopback the way it is inside a Linux network
namespace — it is the one shared host loopback that every other process on the same
machine can also bind or connect to. Pinning the Seatbelt allow rule to the proxy's
exact port (rather than the wildcard `localhost:*` other implementations use)
narrows the child to reaching *only* that port, but it cannot make that port private
to the child the way a network namespace makes loopback private to the sandboxed
process tree. If anything else on the host is listening on that exact port —
unlikely with a randomly chosen ephemeral port, not impossible — the sandboxed child
could reach it, a category of exposure the Linux backend does not have at all. This
must be stated plainly in ADR 0005 when a macOS amendment is written, not glossed
over as an equivalent guarantee with a different implementation.

**Deprecation risk, compared honestly against the Linux equivalent.** Both backends
depend on a host tool outside this codebase's control — `bwrap` for Linux,
`sandbox-exec`/Seatbelt for macOS — and ADR 0005 already accepts that class of risk
for Linux. The macOS version is materially worse: `bwrap` is an actively maintained,
non-deprecated open-source project, while `sandbox-exec` and `sandbox_init` have
carried Apple's deprecation warning for years with no published non-App-Store
replacement, and the open upstream issue cited above shows the situation is
unresolved industry-wide, not just unresolved by this repo's research. A macOS
backend built on it should be documented as riding a mechanism Apple could remove
with less notice than an open-source dependency would.

**Not resolved by this spike, left for real hardware:** the exact Seatbelt grammar
above is assembled from multiple secondary sources, not one authoritative reference,
and small syntax details (the precise `network-outbound`/`remote ip` clause,
`sandbox-exec`'s exact exit code and stderr text on a filesystem or network refusal,
whether `-D` parameter substitution behaves as documented across the currently
shipping macOS versions) need to be confirmed by running real commands, the same way
the Linux design was confirmed before task 2b.4d opened. Also unexplored: whether a
Linux-style Unix-domain-socket relay (narrower than any `localhost` port allow,
since a UDS path is filesystem-scoped like the workspace mount rather than
network-scoped) is possible on macOS instead of the localhost-port model — no
source found during this research addressed this either way, and if it works it
would close the shared-loopback exposure above entirely. This repo already has
macOS CI access (Phase 0's `macos-latest` runner passed Build/Check), which is the
right place to run that prototype before opening an implementation task, mirroring
how the Linux prototype gated task 2b.4d.

Sources consulted: [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime),
[apple/containerization#737](https://github.com/apple/containerization/issues/737),
[openai/codex#215](https://github.com/openai/codex/issues/215),
[Sandboxing subprocesses in Python on macOS](https://zameermanji.com/blog/2025/4/1/sandboxing-subprocesses-in-python-on-macos/),
[Claude Code Sandboxing: How /sandbox Works](https://www.claudecodecamp.com/p/claude-code-sandboxing-how-sandbox-works-and-what-it-doesn-t-protect).

### Amendment (2026-08-13): macOS prototype evidence — task 2b.5

The fourth amendment's design was run for real, via a `workflow_dispatch`-only
GitHub Actions job (`macos-sandbox-spike.yml`, `macos-latest`, deleted after this
amendment recorded its output — the same "ad hoc, not carried forward" treatment
the first amendment's Linux prototype scripts got) against **macOS 26.5.2, Darwin
25.5.0, arm64 (`macos-26-arm64` runner image, `sandbox-exec` at `/usr/bin/sandbox-exec`)**.
Four runs were needed, not one — each failure was real evidence about a wrong
assumption, not noise, and is recorded below because the wrong assumptions are as
informative as the right design:

1. **Run 1 — both candidate profiles unusable as designed.** `(import "bsd.sb")`
   does not grant `process-exec*`. Every probe that tried to launch a child
   (`/bin/sh`, `node`) was denied before reaching the filesystem or network logic
   under test: `sandbox-exec: execvp() of '/bin/sh' failed: Operation not
   permitted`, exit 71, confirmed in the unified log as `deny(1) process-exec*
   /bin/sh`. **The fourth amendment's profile sketches were incomplete** — an
   explicit `(allow process-exec*)` is required.
2. **Run 2 — filesystem candidate now fully validated; network/UDS candidates
   crash before reaching the sandbox logic.** With `(allow process-exec*)` added,
   the filesystem candidate worked exactly as designed (see validated profile
   below). The network and UDS candidates instead aborted: `dyld[…]: Library not
   loaded: @rpath/libnode.137.dylib … 'file system sandbox blocked open()'`, exit
   134 (`SIGABRT`). `bsd.sb`'s baseline covers standard system paths (`/bin/sh`'s
   own dependencies) but not a Homebrew-installed `node`'s shared-library tree at
   `/opt/homebrew/…` — the runtime's own install directory needs an explicit
   `file-read*` allow, exactly what `linux-backend.ts`'s `readOnlyMountArguments()`
   already does by walking the runtime path's ancestors.
3. **Run 3 — same fix applied, new failure: the probe scripts themselves were
   unreadable.** `node:fs:441 … Error: EPERM: operation not permitted, open
   '/Users/runner/work/_temp/probe-connect.js'`. The candidate profiles allowed the
   runtime's own lib path and (for the UDS case) the workspace, but never the
   directory holding the script `node` was told to run — a spike-scaffolding gap,
   not a sandbox-design finding, fixed by allowing that directory too.
4. **Run 4 — clean run, both headline open questions answered:**

**Filesystem candidate, validated as designed:**

```scheme
(version 1)
(import "bsd.sb")
(allow process-exec*)
(deny file-write*)
(allow file-write* (subpath (param "WORKSPACE")))
```

Write inside the workspace: `WRITE_INSIDE_OK`, exit 0. Write outside: `/bin/sh:
.../outside.txt: Operation not permitted`, exit 1 — the shell's own error, not a
`sandbox-exec` wrapper message, exactly the same shape Linux's own fs probes
already rely on (the launched command's own syscall fails and prints its own
error; nothing macOS-specific needs to parse `sandbox-exec`'s own output).

**Network candidate — headline question 1 answered: does pinning to one exact
port actually narrow exposure, or is it cosmetic given the shared host loopback?**
**It narrows exposure — confirmed, not assumed:**

```scheme
(version 1)
(import "bsd.sb")
(allow process-exec*)
(allow file-read* (subpath "<runtime install path>"))
(allow file-read* (subpath "<script/workspace path>"))
(deny network*)
(allow network-outbound (remote ip (param "ALLOWED_ADDR")))
```

- Connect to the allowed pinned port: `RESULT:CONNECTED`, exit 0.
- Connect to a **different** local port, also on `127.0.0.1`, not named in the
  allow rule: `RESULT:ERROR:EPERM`, exit 1. This is the load-bearing result: the
  Seatbelt rule genuinely discriminates between two ports on the same loopback
  address rather than opening the whole `localhost` range the way the wildcard
  `localhost:*` pattern (used in some published profiles, including reportedly
  Anthropic's own) would. Pinning is real, not cosmetic.
- Connect to `example.com:443`: `RESULT:ERROR:ENOTFOUND` — a DNS-resolution
  failure, not a connection-level refusal. Node's `net.connect()` resolves the
  hostname before attempting the TCP connect, and that resolution itself did not
  succeed under this profile (the unified log shows `node(…) deny(1)
  file-read-data /Library/Preferences/com.apple.networkd.plist` and `deny(1)
  file-read-data /private/etc/hosts` around the same moment, suggesting the
  resolver path itself hit sandbox denials). The practical effect is what
  matters — a non-allowed external host is unreachable — but this repo cannot
  state with confidence *which* layer is responsible for macOS the way the first
  amendment could cite an exact Linux errno; that would need a literal-IP probe
  (bypassing DNS entirely) to isolate, not done here.

**UDS candidate — headline question 2 answered: does `(deny network*)` also gate
AF_UNIX, or is a Unix-domain-socket filesystem-scoped the way it is on Linux?**
**It is gated — the Linux-style UDS-relay design does not transfer to macOS "for
free":**

```scheme
(version 1)
(import "bsd.sb")
(allow process-exec*)
(allow file-read* (subpath "<runtime install path>"))
(allow file-read* (subpath "<script path>"))
(deny network*)
(allow file-read* file-write* (subpath (param "WORKSPACE")))
```

No `network-outbound` allow at all — only `file-read*`/`file-write*` on the
workspace subpath containing the socket. Connecting to a UDS at that path still
produced `RESULT:ERROR:EPERM`, exit 1. Seatbelt treats an `AF_UNIX` `connect()` as
subject to `(deny network*)`, not as a plain filesystem operation exempted by
allowing the socket's path. **This rules out the "closes the shared-loopback
exposure entirely" alternative the fourth amendment left open** — at least for the
one profile shape tested here; whether some other, more specific Seatbelt clause
could scope network access to a single `AF_UNIX` path was not explored and remains
genuinely unknown, not ruled out on principle. The localhost-port model above is
the confirmed, working path forward; the UDS alternative is not a free win and
would need its own dedicated investigation to even determine feasibility.

**A finding about evidence-recording, not about the boundary itself:** the
`log show --predicate 'sender == "Sandbox" …'` best-effort step reliably captured
`process-exec*` and `file-read`/`file-write` denials across all four runs, but did
**not** log the network-outbound or AF_UNIX denials from run 4, even though the
child unambiguously received `EPERM` from the kernel. A macOS backend's
violation-evidence strategy should therefore lean on the sandboxed child's own
observable failure (exit code and stderr) for network refusals — exactly what
`linux-backend.ts` already does today — rather than on `log show` or OSLog
integration, which this evidence shows is unreliable for this category of denial,
not merely more complex to wire up.

**What this amendment does and does not settle.** It replaces "assembled from
secondary sources" with "run on the real primitive" for the specific profile
shapes above, on one specific OS build. It does not reduce the network guarantee's
categorical gap from Linux recorded in ADR 0005's second amendment: pinning to one
port is confirmed to exclude a *different* port, but nothing here tests or rules
out a collision with something else already listening on that exact port when the
sandbox launches — that is a structural property of a shared host loopback, not a
bug a sharper profile can close. It also does not cover Apple Events/Launch
Services denial, code-signing behavior for a distributed (not locally-built)
binary, or a real `network-proxy.ts` TCP-listen mode — all still open, unstarted
work for whenever an implementation task opens.

### Amendment (2026-08-13, second): implementation landed — task 2b.5

The prototype design above was implemented against real code: `core/sandbox/
macos-backend.ts` (new, mirrors `linux-backend.ts`'s `SandboxBackend` shape),
`network-proxy.ts` gained a `tcpHost` TCP-listen mode, and `cli-supervisor.ts`
routes to the macOS or Linux backend by `process.platform`. See
`docs/plans/2026-08-12-os-sandbox.md` task 2b.5 for the full record, including
five real, hardware-only bugs found and fixed across six `macos-latest` CI
iterations (a missing `process-exec*`/`process-fork` allow, unresolved symlinks
in `subpath` matching, a missing `spawn()` `cwd`, and a read-only allowlist that
broke ordinary process startup until it was replaced with Linux's actual
broad-read-narrow-write posture). Final verified state: 238 test files / 2112
tests passed, 0 failed, on real macOS 26.5.2 — not a local run, this development
environment has no macOS host. Apple Events/Launch Services denial and
code-signing behavior for a distributed binary remain out of scope, not settled by
this amendment. The Linux sandbox's own CI-testability gap found along the way
(`bubblewrap` was never installed on `ubuntu-latest`, and installing it surfaces a
separate, unrelated network-namespace CI restriction) is tracked in the plan as a
deliberate follow-up, not fixed here.

### Amendment (2026-08-13, third): Linux CI-testability gap closed — task 2b.7

The gap the prior amendment deferred is now closed. Root cause, confirmed on real
`ubuntu-latest` CI (not guessed): the runner's Ubuntu 24.04 image restricts
unprivileged user-namespace creation via AppArmor by default
(`kernel.apparmor_restrict_unprivileged_userns=1`), which blocks the bare
`unshare(CLONE_NEWUSER|CLONE_NEWNET)` that `bwrap --unshare-net` depends on — not
something specific to Bubblewrap's own loopback setup, and not a bug in this
repo's sandbox code. The fix is one line, run before `bwrap` is invoked:
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, scoped to the
ephemeral runner VM. `ci.yml`'s Linux dependency step now installs `bubblewrap`
and sets this. Verified twice: once via a throwaway diagnostic workflow that also
ran this repo's real `test/sandbox/` suite (10 files / 29 passed / 4 skipped
macOS-only / 0 failed), and again in the production CI matrix itself (240 files /
2114 tests passed / 53 skipped / 0 failed on the required `ubuntu-latest` job).
See `docs/plans/2026-08-12-os-sandbox.md` task 2b.7 for the full investigation
record. This does not change any boundary guarantee — it only makes the guarantee
ADR 0005 already claims for Linux actually checked by CI going forward, which it
was not before.

### Amendment (2026-08-17): host tool projection — fd and rg cross the boundary

The boundary had a gap that only showed up once the sandbox became the normal
startup path: **the child could neither find nor install `fd` and `rg`.** Launching
`apex-code` in any workspace printed

```
fd not found. Downloading...
ripgrep not found. Downloading...
Failed to download fd: fetch failed
Failed to download ripgrep: fetch failed
```

Two independent causes, both by design and both confirmed by running the real
captured `bwrap` argv rather than by reading the code:

1. **`--tmpfs /home` hides every host installation.** The child inherits `PATH`
   (`PATH` is in `SAFE_CHILD_ENVIRONMENT_KEYS`), so its `PATH` still names
   `~/.local/bin` and the host tools directory — but both live under `/home`, which
   the sandbox replaces with an empty tmpfs. `commandExists()` therefore gets ENOENT
   for `fd`, `rg`, and `fdfind` alike. The host tool cache at
   `~/.apex-code/agent/bin` is hidden by the same mount, plus the `--tmpfs` that the
   credential projection lays over `~/.apex-code/agent`.
2. **The fallback download cannot succeed either.** `--unshare-net` leaves the child
   with no route, and its only egress is the relay's `HTTP_PROXY` into the
   supervisor's CONNECT proxy, which refuses any host absent from
   `network.allowedHosts`. That list is empty unless the user configures one, so
   `github.com` is refused with 403 and undici surfaces the generic `fetch failed`.

Deferring to `network.allowedHosts` was rejected as the fix. It would require every
user to allowlist GitHub to get a working default install, it re-downloads into every
workspace (the child's `getBinDir()` resolves under the per-workspace
`sandbox-agent` directory), and it widens the network policy to solve a filesystem
problem.

**What was implemented instead.** The supervisor resolves both tools on the host —
where the home directory and the network are both still reachable — and projects each
one read-only at the exact path the child's existing lookup already checks:

- `resolveHostToolBinary()` (`utils/tools-manager.ts`) returns an *absolute* host
  path, checking the managed tools directory first and then scanning `PATH` for each
  accepted system name. `getToolPath()` may return a bare command name because its
  callers spawn through `PATH`; a sandboxed child cannot use that, so this is a
  separate resolver rather than a change to the existing one. Debian's `fdfind` alias
  resolves here and is projected under the child-side name `fd`.
- `prepareHostToolBinaries()` runs `ensureTool()` on the host first, so a missing tool
  is downloaded once, outside the boundary, and then serves every workspace.
- `SandboxLaunch.readOnlyBinaries` carries `{source, destination}` pairs;
  `buildSandboxedCliLaunch()` sets each destination to
  `<workspace>/.apex-code/sandbox-agent/bin/<name>`, mirroring the child's own
  `getBinDir()`.
- The Linux backend emits `--ro-bind source destination` **after** the workspace
  `--bind`. Order is load-bearing: the destinations sit inside the workspace, so an
  earlier mount would be masked when the workspace is bound over it.

The child's startup call is unchanged and now returns working paths with no output
and no network. Verified inside the real sandbox: `ensureTool("fd")` and
`ensureTool("rg")` print nothing and return
`<workspace>/.apex-code/sandbox-agent/bin/{fd,rg}`, which execute as `fd 10.4.2` and
`ripgrep 14.1.1`. A write to a projected binary fails with `Read-only file system`.

No boundary guarantee is relaxed. Two specific host executables become readable and
executable inside the child; nothing becomes writable, and the network policy is
untouched — a workspace with no allowlisted hosts still reaches nothing.

macOS needs no equivalent change: Seatbelt leaves the host filesystem readable, so
the child's `PATH` lookup already finds host installations there. `readOnlyBinaries`
is optional and the macOS backend ignores it.

**Deletion inventory.** Nothing is made obsolete. No file, flag, or setting is
removed; `network.allowedHosts` keeps its meaning and remains the only way to permit
outbound hosts.

**Follow-up within this amendment: the mountpoint stub.** Projecting a tool means
bind-mounting a host binary over a path in the child's tools directory, and Bubblewrap
materialises that destination as an empty file on the host before mounting over it.
That stub outlives the namespace. It is harmless while projection keeps happening —
the next launch mounts the real binary straight back over it — but if the host tool
later disappears, nothing is projected and `getToolPath()`'s `existsSync` check would
hand the child a 0-byte, non-executable file as its binary, failing at exec time with
no indication of the cause. Closed on both sides: `getToolPath()` now requires an
executable file rather than an existing one (sharing `isExecutableFile` with
`resolveHostToolBinary`), and `buildSandboxedCliLaunch()` clears zero-byte entries
from the tools directory before each launch. A genuinely downloaded binary is never
empty, so size is a safe discriminator. Verified against real leftover stubs from an
earlier launch: both were removed, and a real executable alongside them survived.

### Amendment (2026-08-17, second): the proxy socket moves out of the workspace

The allowlist proxy's Unix domain socket was created at
`<workspace>/.apex-code/sandbox-state/proxy.sock`. AF_UNIX caps `sun_path` at 108
bytes, and that fixed 36-character suffix left roughly 72 characters for the user's
own directory layout. Past that the sandbox did not degrade — it failed to start at
all, with `Error: listen EINVAL: invalid argument <path>`, which names the socket but
not the reason. Measured on a real machine: a 108-character socket path still binds,
126 does not. On the development machine that wrote this, 24 of 143 scanned project
directories exceeded the limit, including this repo's own
`packages/coding-agent` — running `apex-code` there could not launch.

Two constraints shaped the fix, both established by experiment rather than assumed:

- **Abstract sockets cannot be used.** The Linux abstract namespace is scoped per
  network namespace, and `--unshare-net` is the boundary's foundation. Verified: a
  listener on the host accepts a same-namespace connection and the identical connect
  from inside `bwrap --unshare-net` fails with `ECONNREFUSED`.
- **The child-side mountpoint must sit under `/home`.** The sandbox root is a
  read-only bind, so bwrap cannot create a mountpoint on it: `--bind` to
  `/run/apex.sock` or `/tmp/apex.sock` both fail with "Can't create file … Read-only
  file system", and `--dir /run/apex` fails with "Can't mkdir". The `/home` tmpfs is
  the one writable mount at that point in the argument order, so the bind is emitted
  immediately after it.

The host side now gets a short unique path under the system temp directory
(`resolveProxySocketPaths()`, which falls back to `/tmp` if an unusually long `TMPDIR`
would reintroduce the same limit), bind-mounted to `/home/<name>.sock` in the child.
`APEX_UDS_PATH` carries the child-side path to the relay. Because the socket no longer
lives under the workspace, nothing else would ever clean it up, so the launch path
unlinks it in its `finally`.

Verified end to end: `packages/coding-agent`, which previously could not start, now
launches; so does a 171-character workspace whose old socket path would have been 207
bytes. No socket is left behind in the temp directory afterwards.

**Deletion inventory.** Nothing is removed. The socket's old location under
`sandbox-state` is no longer used; the directory itself remains, as it still holds the
relay script and the child's `HOME`.

### Amendment (2026-08-17, third): a refused host now says so

The boundary refused correctly and reported uselessly. A host absent from
`network.allowedHosts` got a 403 on CONNECT; undici phrases that as
`Proxy response (403) !== 200 when HTTP Tunneling`, but `fetch` surfaces only
`TypeError: fetch failed` at the top of the cause chain. The caller — a model
provider, the version check, a catalog fetch — therefore reported a bare network
failure naming no host, no reason, and no remedy. The recorded violation did name the
host, but it printed at process exit, after the operation had already failed.

That single missing sentence is what made every gap in this spec expensive to
diagnose. The tool-download failure that prompted the projection amendment presented
as `Failed to download fd: fetch failed`; the real cause was an empty allowlist, and
nothing on screen said so.

`core/sandbox/network-refusal.ts` walks the cause chain for undici's tunnel-refusal
wording and, on a match, replaces the message with one naming the host and the setting
that would permit it. It is installed by `child-entry.ts` only — the sandboxed child is
the one context where attributing a refused CONNECT to the sandbox allowlist is a fact
rather than a guess about whose proxy answered. Anything that is not a refusal is
rethrown untouched, so retry and abort handling are unchanged for every other failure.

Before: `fetch failed`, then four identical violation lines at exit.
After: `Host generativelanguage.googleapis.com is not on the sandbox network allowlist,
so the request was refused. Add it to "network.allowedHosts" in your global Apex Code
settings to permit it.`

A deliberate side effect worth recording: the refusal is now reported as a plain
`Error` rather than the transport `TypeError` upstream retry logic recognises, so a
refusal is attempted once instead of three times — four violation lines collapse to
one. This is correct rather than merely quieter, because an allowlist refusal is a
deterministic policy decision and retrying it cannot change the outcome.

**Deletion inventory.** Nothing is removed. The violation store keeps recording
refusals and printing them at exit; this adds the message at the point of failure,
where it can still affect what the user does next.

### Amendment (2026-08-17, fourth): model providers are reachable by default

`network.allowedHosts` defaulted to empty, and the proxy denies anything absent from
it. The consequence was not a hardened default but a non-functional one: a fresh
install could not reach any model at all. Verified on a clean configuration directory
before this change — the first request failed, four identical violations printed at
exit, and nothing on screen named `generativelanguage.googleapis.com`, which is an
implementation detail of the provider rather than something a user could be expected
to know. Denying by default only protects anyone if the working configuration is
reachable without it; otherwise the first thing every user does is discover the
setting and widen it, with less information than we have.

`core/sandbox/default-hosts.ts` now supplies the 31 statically known model-provider
hosts plus the update check host, and `resolveSupervisorAllowedHosts()` merges
configured entries on top. `network.allowDefaultHosts: false` restores strict
deny-all for anyone who wants it.

Two implementation constraints, both measured rather than assumed:

- **The list is materialised, not derived at runtime.** Importing
  `@earendil-works/pi-ai/providers/all` costs ~190ms, which the supervisor would pay on
  every launch before the child starts. `test/sandbox/default-hosts.test.ts` recomputes
  the set from `builtinProviders()` and fails if the copy drifts, so a provider added
  upstream cannot silently become unreachable.
- **The update-check host is duplicated, not imported.** Importing `version-check.ts`
  for one string pulled ~40ms of dependency chain into the supervisor's path (best of
  five: 66ms for the module versus 2.9ms without it). A test asserts the constant
  matches `VERSION_CHECK_HOST`.

Scope is deliberately limited to providers whose `baseUrl` is statically knowable.
Bedrock, Azure, Cloudflare, Vertex, and the self-hosted providers resolve their
endpoint from account or environment configuration the supervisor cannot see; they
still need an explicit entry, and the refusal message from the previous amendment now
names the host to add. A mid-session `/model` switch to such a provider is likewise
still refused, because the proxy's allowlist is fixed when the session starts.

**Known consequence, not fixed here.** With provider hosts reachable, an ordinary
non-zero child exit — an invalid API key, a failing command — now surfaces
`Sandbox violation (unknown): … Sandboxed process exited unsuccessfully`, because
`linux-backend.ts` records a fallback violation for any unsuccessful exit that the
proxy did not already explain. That line blames the boundary for failures it had no
part in. It was largely masked before, since a first run failed at the network refusal
instead. Tracked as follow-up work.

**Deletion inventory.** Nothing is removed. `network.allowedHosts` keeps its meaning
and remains the way to permit anything outside the default set.

### Amendment (2026-08-17, fifth): the boundary stops blaming itself

The follow-up recorded in the previous amendment is closed. `linux-backend.ts` recorded
a violation for *any* non-zero child exit the proxy had not already explained,
classifying it as `unknown` with the detail "Sandboxed process exited unsuccessfully;
inspect its stderr for the OS refusal." Nothing had been refused. An invalid API key, a
failing test command, or a script exiting 1 all produced a sandbox violation, sending
whoever read the output looking for a refusal that never happened.

`classifySandboxFailure()` now returns `undefined` when the child's stderr evidences no
OS refusal, and the caller records nothing in that case. A non-zero exit is not a
violation; Linux's own refusal wording still is, and network refusals are recorded by
the proxy before this fallback is consulted.

This is deliberately Linux-only. `macos-backend.ts` keeps its own coarser
classification, which reports genuine denials as `unknown` because Seatbelt's denial
text does not reliably separate filesystem from network — `cli-supervisor.test.ts` and
`macos-backend.test.ts` assert exactly that. Applying the same narrowing there would
suppress real enforcement signals, and this development environment has no macOS host
to verify a replacement against. The equivalent macOS false positive is therefore still
open, and is not claimed as fixed.

**Deletion inventory.** The `unknown` classification is gone from the Linux backend and
with it the "inspect its stderr for the OS refusal" detail string. `SandboxViolation`
keeps the `unknown` kind, which macOS still uses.
