# Architecture Overview

The layer map: what Apex Code owns, what it borrows, and where each roadmap phase lands.
This is the orientation document — mechanisms are specified in `docs/specs/`,
decisions in `docs/adr/`, vocabulary in `CONTEXT.md`.

For the interfaces that **several phases write to**, see
[`contracts.md`](contracts.md). This document names the load-bearing seams; that one
specifies them.

## Mental model

**Upstream owns reach. Apex Code owns judgment.**

`pi-ai` decides how to talk to 35 providers. Apex Code decides which one to talk to, with
whose credentials, under what permissions, with how much context, and whether the
result can be believed. That split is the whole architecture, and it is why the fork
boundary falls where it does (ADR 0001).

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│  Extensions            user · project · packages · bundled    │
│                        ├─ SpecEngine + governance (Phase 7)   │
├───────────────────────────────────────────────────────────────┤
│  APEX CODE  (fork of pi-coding-agent)                         │
│    Tools ─ permissions ─ sessions ─ compaction ─ eviction     │
│    Delegation ─ evidence capture ─ daemon ─ CLI/RPC/SDK       │
├───────────────────────────────────────────────────────────────┤
│  APEX CODE CORE  (fork of pi-agent-core)                      │
│    Agent loop · steering & follow-up queues · tool execution  │
│    Interception: beforeToolCall · afterToolCall               │
│                  transformContext · prepareNextTurn           │
├───────────────────────────────────────────────────────────────┤
│  pi-ai  (dependency)          │  pi-tui  (dependency)         │
│    35 providers, 9 dialects   │    terminal primitives        │
│    thinking · cache · transport                               │
└───────────────────────────────────────────────────────────────┘
```

Everything above the dependency line is Apex Code's to change. Nothing below it is
(ADR 0001).

## Where each phase lands

| Phase | Layer | What it adds |
| --- | --- | --- |
| 0 Foundation | build/CI | Fork, release pipeline, upstream merge process, **replay corpus** |
| 1 Provider | above `pi-ai` | Credential pool, model roles, fallback chains, measured routing |
| 2 Permissions | core + apex-code | Rule engine at `beforeToolCall`; OS sandbox beneath tool execution |
| 3 Context | apex-code | Tool-result eviction, deferred schemas, reactive compaction |
| 4 Tools | apex-code | The tool surface, each with its own rule grammar |
| 5 Delegation | apex-code | Subagents, capability ceiling, depth bound, artifact isolation |
| 6 State | apex-code | SQLite indices, daemon + clients, command journal, session leases |
| 7 Evidence | core + extension | Capture in core; SpecEngine and policy as a bundled extension |
| 8 Observability | apex-code | Cost and latency accounting, OTel export, status line |
| 9 Release | all | Install, update, session migration, docs, security posture |

## Load-bearing seams

Four places where a design decision propagates through everything after it.

**`beforeToolCall` — the permission seam.** Every tool invocation passes through one
interception point inherited from the agent loop. Permissions (Phase 2) live here,
which is what makes "every tool is gated, with no exceptions list" a testable
property rather than a convention. Nothing may execute a tool by another path.

**`ruleContent` is interpreted by the tool.** A permission rule carries an opaque
string; the tool that owns it decides what it means. This is what keeps the rule
engine from accumulating per-tool special cases, and it is why the tool surface
(Phase 4) cannot land before the rule model (Phase 2) — every tool built earlier is a
retrofit. The same argument applies to three further axes, which is why all four are
settled together in [`contracts.md`](contracts.md) § 1 rather than one per phase
(ADR 0010).

**`transformContext` — the context seam.** Compaction, eviction, and deferred schema
resolution all rewrite the message list at one point before the provider call. Their
combined effect is measurable in one place, which is what makes the Phase 3 exit
criterion checkable at all.

**Evidence is captured by the tool that produced it.** The bash tool records its own
exit code and argv; the edit tool records its own patch hash and paths. An extension
observing tool results afterward can only reconstruct, and reconstruction is the
accuracy ceiling Phase 7 exists to break. This is the one thing that must live in
core rather than in the governance extension (ADR 0007).

## What stays an extension

The SpecEngine, verification gates, and governance policy ship bundled but remain an
extension, switchable off and independently testable. That separability is not
incidental: it is how the layer's calibration was earned in the predecessor harness,
where field data showed most gate failures came from template-generated criteria
nobody wrote. A policy layer welded into core cannot be measured against a build
running without it.

## Inherited invariants

Properties of Pi that Apex Code keeps, and that changes must not quietly break:

- **Sessions are a tree.** JSONL entries linked `id`/`parentId`; branching happens in
  place without new files. `/tree` navigation and branch summarization follow from
  this, and the distributable posture makes the format a compatibility promise
  (ADR 0006, Phase 6).
- **Every state change is an entry.** Model changes, thinking-level changes, and
  service-tier changes are recorded alongside messages, so a session replays exactly.
  The Phase 0 replay corpus depends on this remaining true.
- **Extensions can register providers at runtime.** A local or unlisted endpoint is a
  first-class model without a code change — the practical meaning of
  "provider-agnostic."
- **The agent loop settles.** `agent_end` listeners are awaited before the agent is
  idle. Anything added to the loop must preserve that, or "the turn is done" stops
  being a reliable signal for everything built on top of it.
