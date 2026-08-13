# ADR 0010 — One canonical tool contract, declared by the tool and never re-derived

**Status:** Accepted · **Date:** 2026-08-08

> **On the number.** ADR numbers are allocated when an ADR is *written*, not when its
> phase is forecast. `docs/roadmap.md` reserves 0004–0009 for decisions expected in
> Phases 2–9; several are already cited by name in written documents, so they are not
> reassigned. This ADR was written early — before the phases that consume it — and
> takes the next free number.

Upstream `ToolDefinition` describes a tool to the model and to the renderer. It says
nothing about how the tool is authorized, whether its output may be evicted, whether
its schema may be deferred, what capability class it belongs to, or what evidence it
produces. Apex Code needs all five, and they are needed by four different roadmap phases
(2, 3, 5, 7) that consume roughly fifteen tools built in a fifth (4).

Left to itself, each phase would add its own field in its own spec, and every tool
built before the last of them would be reopened once per remaining axis. The
predecessor harness has already paid this: ADR 0021 there records capability and risk
classification being derived once for authorization and separately re-derived for
every surface that displayed it, until the two disagreed and a real registered tool
fell through both classifiers into neither.

**Every Apex Code tool declares one `contract` covering all four axes — capabilities,
permission grammar, context behavior, evidence emission — and one projection function
serves every consumer that describes rather than enforces.**

The shape is specified in `docs/architecture/contracts.md` § 1 and is settled now,
before Phase 2 writes its spec. Individual fields are *consumed* in their own phases;
they are *declared* from the moment a tool exists.

Three properties are the decision, and each was chosen against a cheaper alternative:

**`contract` is required, and so is every sub-field.** A tool cannot compile without
answering all four axes. Optional fields would let a new tool default silently into
"unclassified," which is precisely the gap ADR 0021 closed — the alternative is not a
cleaner API, it is the same bug with a nicer signature.

**`ruleContent` is interpreted by the tool.** The permission engine holds no
tool-specific matching. `Bash(git commit:*)` and `Read(~/.ssh/**)` are different
grammars owned by different tools, and the engine stays small because it never learns
either. The tool owns both directions — matching a rule and generating one — so the
two cannot drift, which invariant 5 tests as a property across the whole registry.

**One projection, never a second classification.** `buildToolContractSnapshot()` is
the sole source for `/tools`, `/doctor`, generated reference docs, and the drift
test. It calls the same predicates the enforcement path calls and re-implements none
of them, and nothing it returns is an authorization input. A future surface that
needs to describe the tool surface consumes the snapshot; a second independent
classification is the drift this ADR exists to prevent and is not a pattern to repeat
for a new consumer.

Foreign tools — from MCP servers and third-party extensions — cannot supply a
contract. They are neither rejected nor silently defaulted. They receive a
conservative `UNCLASSIFIED` contract (full capability set, `ask`, never evicted,
schema fully announced, emits nothing) **and are reported as unclassified** wherever the
snapshot is displayed. A conservative default nobody can see is indistinguishable
from a bug, which is the specific way the predecessor's version of this failed.

Consequences accepted: seven upstream-inherited tools must be backfilled with
contracts in Phase 2, and every future tool costs four declarations it would not
otherwise carry. That is the price of the axes being answered once each instead of
three times each, and it is paid at the only moment when the answers are cheap.

## Amendment (2026-08-13): foreign schemas remain fully announced

Phase 4's deferred-schema load-path review retains `UNCLASSIFIED` as the shared
fallback for foreign and extension tools, but changes only its provider-facing schema
posture: `context.deferSchema` is `false`. The fallback remains conservative for
capabilities, permission (`ask`), result eviction, and evidence. Foreign tools cannot
be made usable by a load path they do not explicitly participate in, and keeping their
real schemas announced preserves the existing extension/MCP behavior. ADR 0011 records
the explicit first-party load path and the single-fallback rule that prevents the gate
and context pipeline from deriving different classifications.
