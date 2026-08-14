# ADR 0008 — Delegation authority: an in-process derived child, not a subprocess with serialized authority

**Status:** Accepted · **Date:** 2026-08-14

> **On the title.** This ADR was reserved in `docs/roadmap.md` as "Delegation
> authority: `pi-subagents` dependency vs. owning it." That question is not
> answerable: no package named `pi-subagents` exists in this repository's dependency
> graph or in upstream Pi's ten-package inventory at the fork point
> (`docs/upstream-log.md`). The title is corrected here to the decision that is
> actually open, discovered while drafting `docs/specs/2026-08-14-delegation-and-multi-agent.md`.

## Decision

A delegated child agent runs **in-process**, as a real `AgentSession` built from the
parent's live services, with its permission store, permission mode, and tool set
**derived** from the parent's in-memory state at delegation time — never
reconstructed from disk, argv, or environment variables.

Concretely: the child's permission store is a read-through view of the parent's live
snapshot, overlaid with a child-local scope that absorbs the child's own writes; the
child's effective capability set is computed once, at delegation time, as the
intersection of the parent's expanded capability set and the agent definition's
requested set; and the child's tool list is derived from that computed set, not taken
directly from the agent definition. All of this is detailed in
`docs/specs/2026-08-14-delegation-and-multi-agent.md`, which this ADR exists to
unblock.

## Why this shape

**The alternative is a subprocess with authority serialized across the process
boundary, and that boundary is where the guarantee breaks.** Apex Code's permission
rule model has eight sources; four of them — `flag`, `cliArg`, `command`, `session` —
are runtime-only and held in memory for the life of the process
(`core/permissions/store.ts:8-35`). The `session` source is specifically where a rule
lands when a human answers an approval prompt with "always" (`gate.ts:83-89`). None of
that state exists anywhere a spawned CLI process could read it. The repository already
contains one working delegation implementation —
`examples/extensions/subagent/` — and it demonstrates the failure directly: it spawns
a fresh `pi` process per child with a `--tools` allowlist read from a markdown
frontmatter file, and a child launched this way starts in `default` permission mode
and with none of the parent's runtime-only rules, regardless of what the parent was
actually permitted to do.

The exit criterion this phase is held to is "a child agent cannot obtain a grant its
parent lacks." A subprocess design can only meet that criterion by correctly
serializing all eight rule sources, the resolved mode, and the capability ceiling
across argv/env on every delegation, forever, including every source added after this
ADR is written. That is a discipline, not a guarantee, and a forgotten field fails
silently — the child simply has more authority than it should, and nothing in the
type system or the test suite notices unless someone thought to test that exact field.

An in-process derived child makes the guarantee structural instead. The child's gate
is an object the parent's code constructs, from data the parent's code already holds.
There is no serialization step to get wrong, because there is no process boundary to
cross. `contracts.md` §1.1's capability ceiling and the `exec` escalation rule become
properties checked once by a pure function over values already in scope, not values
reconstructed after a round trip through disk.

**Context isolation — the actual product benefit of delegation — does not require a
process boundary.** A child `AgentSession` has its own message list, its own context
pipeline, and its own compaction state regardless of whether it runs in the parent's
process or a forked one. The subprocess model's isolation is a side effect of process
separation, not something a process boundary uniquely provides; an in-process child
gets the same isolation from `AgentSession` being a session, not a global.

**This does not remove the sandbox boundary.** ADR 0005's sandbox is a whole-CLI-launch
model: the entire process runs inside a bwrap child, and a subprocess spawned from
within it is itself within it. An in-process child is trivially within it too. The
sandbox boundary is identical under both designs and is not the axis this ADR decides.

## Consequences

- A child agent's authority is checked once, by a pure ceiling function, against
  values the parent's code already holds — no serialization surface, no argv/env
  encoding, nothing to keep in sync as new permission sources are added.
- A misbehaving, hanging, or resource-heavy child runs inside the parent's process,
  not in an OS-isolated subprocess. It is bounded by the recursion depth guard and the
  existing abort path, not by process teardown.
- The delegation runtime must implement store derivation (parent-snapshot read,
  child-local write overlay) as new machinery; it is not reused from the subprocess
  example, whose model this ADR rejects.
- `examples/extensions/subagent/` is retained as upstream example code, unmodified,
  and is not the implementation this phase builds on. It remains cited in the spec as
  the concrete illustration of the rejected alternative's failure mode.
- Every future permission-rule source or mode behavior automatically applies to
  delegated children, because they share the enforcement code path
  (`evaluateToolCall`) rather than a re-derived one. This is the same reasoning ADR
  0010 applies to tool contracts: one derivation, consumed everywhere, rather than one
  re-implemented per consumer.

## Rejected alternatives

- **Subprocess with serialized authority (the example extension's model, made
  correct):** spawn a CLI child and serialize mode, all eight rule sources, the
  ceiling, and the depth across argv/env. Rejected because fidelity becomes a
  permanent, silent-failure-prone obligation rather than a structural property — see
  Why this shape. This is the shape the roadmap's original scope sentence assumed
  existed as `pi-subagents`; it does not, and building it from scratch does not change
  the reasoning against it.
- **Forward the parent's permission responder to the child**, so an `ask` in the child
  prompts the same human. Rejected in the spec this ADR unblocks
  (`docs/specs/2026-08-14-delegation-and-multi-agent.md`, "Who answers a child's
  `ask`"): it asks a human to approve a call they did not make, from a context they
  cannot see, and an approval there would need to land somewhere — if it lands in the
  parent's store, it re-opens exactly the widening risk this ADR's derived-overlay
  design closes.
- **Share the parent's store instance directly**, rather than deriving a read-through
  view. Rejected because a child's `answer.persist` write would land in the parent's
  own store (`gate.ts:83-89`), meaning a child's approval widens its parent — an
  inversion of the ceiling, not merely a failure to enforce it.
