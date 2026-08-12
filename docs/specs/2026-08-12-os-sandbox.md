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
The first delivery supports Linux through Bubblewrap with an isolated network namespace
and proxy-mediated host allowlisting. macOS Seatbelt support is a follow-up task inside
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
| Linux platform adapter | Initialize `@anthropic-ai/sandbox-runtime` in the supervisor with workspace-only write and empty network policy, then wrap a normal CLI child. | new `core/sandbox/supervisor.ts` |
| CLI launch | Detect child sentinel before `main()`. The outer process supervises the child with inherited stdio; the child never re-launches itself. | `cli.ts`, new launcher module |
| Child environment | Supply only explicit workspace, private temporary/state, runtime/toolchain mounts and controlled proxy bridge; do not mount host home/credential/session directories by default. | platform adapter / supervisor |
| Violations | Record known runtime rejections and native monitor entries in Apex's bounded store; transmit only structured events across the supervisor boundary. | new `core/sandbox/violations.ts` |
| Packaging | Promote the existing exact sandbox runtime dependency to the distributable coding-agent package and regenerate its install lock. | `package.json`, `package-lock.json`, `install-lock/` |

The `beforeToolCall` gate remains inside the child: authorization prevents tool work,
while the outer sandbox constrains every allowed operation afterward. This preserves
one authority decision and one OS boundary rather than creating a special bash route.
The child sentinel is authenticated by an inherited private descriptor/token rather
than a public environment variable alone, so a user cannot invoke an unsandboxed
binary with a claimed-enforced status.

## Deletion inventory

Nothing existing is removed. The direct host-process launch is superseded by the supervisor/child launch for a
normal agent session. Tool interfaces remain unchanged, because their process has
already been confined before they execute.

## Risks

| Risk | Signal | Mitigation |
| --- | --- | --- |
| Host lacks Bubblewrap, Socat, or Ripgrep | startup diagnostic and agent-session refusal | dependency probe before supervisor launch; document packages |
| Sandbox runtime global state leaks across runs | proxy processes remain after child exits | one supervisor owner; idempotent reset |
| Native runtime cannot identify a Linux filesystem rejection | violation test lacks operation/path | record an Apex execution refusal fallback with raw sandbox output; do not fabricate a path |
| Network proxy bypass | child reaches a blocked test host | isolated network namespace plus proxy test against loopback-controlled server |
| Child-sentinel spoofing skips supervision | direct child invocation reports enforced | private inherited launch credential, verified before child executes |
| Misleading scope | docs/UI imply native tools or host process are confined | ADR 0005 non-guarantees copied into public diagnostics/help |
| Dependency API changes | typecheck or adapter integration fails on upgrade | exact pinned dependency, narrow facade, integration test |

## Verification

- Unit tests construct the supervisor facade with a fake backend and cover preflight,
  child sentinel verification, fail-closed status, and violation normalization.
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
