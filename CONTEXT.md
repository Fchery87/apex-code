# CONTEXT

Glossary and relationship map. Definitions and how things connect — nothing else.
Rules live in `AGENTS.md`; rationale lives in `docs/`.

## Upstream

| Term | Meaning |
| --- | --- |
| **Pi** | The upstream harness Apex Code forks. Repo `github.com/earendil-works/pi`, MIT. |
| **`pi-coding-agent`** | Upstream package `packages/coding-agent`. Tools, sessions, compaction, extensions, TUI modes, CLI. **Forked.** |
| **`pi-agent-core`** | Upstream package `packages/agent`. The `Agent` class and agent loop. **Forked.** |
| **`pi-ai`** | Upstream provider layer: 35 providers over 9 API dialects. **Consumed as a dependency.** |
| **`pi-tui`** | Upstream terminal UI primitives. Two runtime deps. **Consumed as a dependency.** |
| **Fork point** | The upstream release Apex Code was forked from. Recorded in `docs/upstream-log.md`. |

## Apex Code concepts

| Term | Meaning |
| --- | --- |
| **Harness** | The whole program: loop, tools, permissions, sessions, extensions. |
| **Agent loop** | Inherited from `pi-agent-core`. Streams a turn, executes tools, repeats. Extension points: `beforeToolCall`, `afterToolCall`, `transformContext`, `prepareNextTurn`. |
| **Steering / follow-up** | Two message queues. Steering injects after the current assistant turn; follow-up runs only when the agent would otherwise stop. |
| **Session** | JSONL file, one entry per line, entries linked `id`/`parentId` into a **tree** — branching happens in place, without new files. |
| **Branch summarization** | Summarizing a session branch on `/tree` navigation. Distinct from compaction. |
| **Compaction** | Summarizing old messages to reclaim context. Triggered by threshold or by a `prompt_too_long` error (reactive). |
| **Eviction** | Dropping old *tool results* in place for replayable tools, leaving a marker. Cheaper than compaction: no summarization call, no structural loss. Phase 3. |
| **Deferred schema** | A tool announced by name only; its JSONSchema loads on demand. Keeps a large tool surface affordable. Phase 3. |
| **Extension** | A TypeScript module loaded via `jiti`, subscribing to lifecycle events and registering tools, commands, shortcuts, flags, and providers. |
| **Project trust** | Upstream Pi's guard on *loading* project-local config and extensions. Not a sandbox and not a permission system. |
| **Permission rule** | `{source, behavior: allow\|deny\|ask, value: {toolName, ruleContent?}}`. `ruleContent` is interpreted by the tool itself. Phase 2. |
| **Tool contract** | The required `contract` field on every tool: capabilities, permission grammar, context behavior, evidence emission. Declared by the tool, consumed by four phases, never re-derived (ADR 0010). |
| **Capability** | What class of thing a tool does — `fs.read`, `fs.write`, `exec`, `net`, `delegate`, `ui`, `state`. A set, not a single value. |
| **Capability ceiling** | A delegated agent can never hold a grant its parent lacks. Enforced against the tool contract's capability sets. Phase 5. |
| **Projection** | `buildToolContractSnapshot()` — the one read-only view of the tool registry that every *describing* surface consumes. Not an authorization engine. |
| **Evidence** | A structured record of what actually happened — exit codes, patch hashes, argv — captured **at the source** by the tool that did it. Phase 7. |
| **Replay corpus** | A fixed set of scrubbed recorded sessions, replayable offline, emitting deterministic metrics. The instrument every phase gate reads. Phase 0. |

## Document types

| Type | Path | Lifecycle |
| --- | --- | --- |
| Roadmap | `docs/roadmap.md` | Permanent. Phase status. |
| Spec | `docs/specs/YYYY-MM-DD-<slug>.md` | Permanent. Design, written before the change. |
| Plan | `docs/plans/YYYY-MM-DD-<slug>.md` | Deleted on completion. Task breakdown. |
| ADR | `docs/adr/NNNN-<slug>.md` | Permanent. One settled decision. |
| Research | `docs/research/YYYY-MM-DD-<slug>.md` | Permanent. Investigation findings. |

## Relationship map

```
                    pi-ai (dep)        pi-tui (dep)
                        │                   │
                        ▼                   ▼
        apex-code-agent-core (fork of pi-agent-core)
                        │
                        ▼
        apex-code (fork of pi-coding-agent)
         │        │            │
         │        │            └── bundled extension: SpecEngine + governance
         │        └── extensions (user, project, packages)
         └── ~/.apex-code/  ← sessions, settings, credentials, state
```

## Prior art referenced

| Name | What it is | Where it's captured |
| --- | --- | --- |
| **Thanos** | The predecessor governance layer: spec contracts, evidence, verification gates. Its evidence model moves into Apex Code core (ADR 0007, Phase 7). | `~/.pi/src` |
| **OMP** | A mature Pi fork. Source of the credential-pool, model-roles, and measured-routing designs. | `docs/research/2026-08-08-harness-comparative-review.md` |
| **Prime** | A mature Pi fork. Source of the daemon-worker journaling, session-lease, and recursion-depth designs. | same |
| **Atomic** | Near-stock Pi plus the community package ecosystem. | same |
| **`c-code`** | Leaked, `UNLICENSED` Claude Code source. A **behavior specification only** — never a source to copy from (ADR 0002). | same |
