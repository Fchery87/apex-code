# ADR 0001 — Fork boundary: fork the agent, consume the provider layer

**Status:** Accepted · **Date:** 2026-08-08

Pi is four MIT packages in one repo (`github.com/earendil-works/pi`):
`pi-ai` (providers), `pi-tui` (terminal primitives), `pi-agent-core` (`packages/agent`,
the `Agent` class and loop), and `pi-coding-agent` (`packages/coding-agent`, tools,
sessions, compaction, extensions, CLI). A fork has to choose how much of that it
owns, and the choice is hard to reverse later — it determines the merge burden for
the life of the project.

**Apex Code forks `pi-coding-agent` and `pi-agent-core`. It consumes `pi-ai` and `pi-tui`
as ordinary versioned dependencies.**

The forked half is exactly the half Apex Code changes. Permissions, sandboxing,
tool-result eviction, and deferred tool schemas all have to intercept below the
extension API — the roadmap's Phases 2 through 5 are not expressible as extensions,
which is why staying a pure extension layer was rejected. Owning the loop and the
tool/session layer is the minimum that makes them possible.

The consumed half is the half that needed no improvement. `pi-ai` covers 35 providers
across 9 API dialects, normalizes thinking levels, cache retention, and transports,
and lazily loads dialects so the import cost is one, not thirty-five. It is the
strongest component in any harness surveyed, and it is also the fastest-churning:
vendors ship models continuously, and every one is upstream's maintenance rather than
ours. Forking it would mean paying that cost forever to gain nothing Apex Code wants.
Apex Code's provider work — credential pooling, model roles, fallback chains, measured
routing (Phase 1) — sits *above* `pi-ai` and needs no changes inside it. Runtime
provider registration through `registerProvider()` already covers custom endpoints.

`pi-tui` is consumed for the same reason in miniature: two runtime dependencies, and
Apex Code has no quarrel with it.

Consequences, accepted deliberately:

- Apex Code is bounded by `pi-ai`'s public API. If something genuinely requires a change
  inside it, the response is an upstream contribution to Pi, not a local patch. A
  local patch to a consumed package is the failure mode this ADR exists to prevent —
  it converts a dependency into an unmanaged fork without anyone deciding to.
- Forked files should stay legible as a diff against upstream. Gratuitous
  restructuring of forked code raises the cost of every future merge; see ADR 0003
  for the ceiling that governs when that cost becomes decisive.
- `pi-agent-core` depends on `pi-ai` by semver range. Apex Code's fork of agent-core
  controls that range and is the single place the upstream provider version is
  pinned.

Revisiting this means crossing the ADR 0003 tripwire, not simply preferring more
control. "We could move faster if we owned it" is the argument this decision already
weighed and rejected.
