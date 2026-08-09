# Research: comparative review of five agentic harnesses

**Date:** 2026-08-08 · **Status:** Permanent — this is the source of record for Apex Code's design inputs

> **Why this document exists.** Per ADR 0002, ideas observed in unlicensed sources may
> enter Apex Code only as *behavioral descriptions*, never as code. This file is that
> channel. Specs and ADRs cite this document; they do not cite the source trees. For
> `c-code` in particular, what follows is a description of externally observable
> behavior and design approach — deliberately not a transcription of its
> implementation.

## Systems reviewed

| Name | What it is | License | Role in Apex Code's design |
| --- | --- | --- | --- |
| **Pi** `0.80.6` / `0.83.0` | `github.com/earendil-works/pi` — ten packages; the four that matter here are `ai`, `tui`, `agent`, `coding-agent` | MIT | **The base.** Forked per ADR 0001. |
| **`c-code`** | Leaked Claude Code source, `v0.0.0-leaked`, ~519k LOC | **UNLICENSED** | **Behavior spec only.** Never a code source (ADR 0002). |
| **OMP** | A mature Pi-lineage fork (state inspected, no source) | — | Source of the credential-pool, model-roles, and measured-routing designs. |
| **Prime** | A mature Pi-lineage fork (state inspected, no source) | — | Source of daemon journaling, session leases, recursion-depth bounding. |
| **Atomic** | Near-stock Pi 0.83 plus community packages | MIT | Evidence of what the ecosystem already supplies. |
| **Thanos** | Predecessor governance extension layer, ~19k LOC on Pi | MIT | The evidence/verification model, moving into Apex Code core. |

OMP, Prime, and Atomic were reviewed as *installed state* — configs, SQLite schemas,
session transcripts, directory layouts. Persisted schemas reveal architecture
reliably; all three are unmistakably Pi-derived (identical session-directory naming,
`thinkingLevelMap`, v3 `id`/`parentId` session trees).

## Finding 1 — Pi's provider layer is the strongest component surveyed

`pi-ai` covers 35 providers across 9 API dialects, each dialect lazily loaded so the
import cost is one, not thirty-five. It normalizes the parts that usually leak: a
`ThinkingLevel` scale with per-model mapping *and* token-budget fallback for
budget-based providers; a cache-retention preference mapped per provider; a transport
preference (SSE / WebSocket); payload and response interception hooks; per-provider
environment scoping.

`c-code`'s equivalent abstraction spans four values — three of which are Anthropic
hosting options. For a provider-agnostic goal it is an anti-reference.

**Consequence for Apex Code:** consume `pi-ai`, do not fork it (ADR 0001).

## Finding 2 — Pi's loop contract is better; `c-code`'s loop hardening is better

Pi's `Agent` exposes every extension point a harness needs as a first-class option:
steering and follow-up queues with drain modes, `beforeToolCall` / `afterToolCall`,
`prepareNextTurn`, `transformContext`, a tool-execution strategy, and event listeners
awaited in subscription order with the run's abort signal — so "the turn is done" is
a reliable signal.

`c-code`'s loop is structurally worse (a very long generator over mutable state) but
carries recovery behavior Pi has not needed yet:

- recovery from output-token-limit failures across a bounded number of attempts, with
  the intermediate error *withheld* from programmatic consumers so an SDK caller does
  not terminate a session that is still recovering;
- compaction triggered *reactively* by a context-overflow error, distinct from
  threshold-triggered auto-compaction;
- a fallback model on failure, a turn cap, and a token budget tracked across
  compaction boundaries;
- speculative prefetching of memory and skill lookups underneath the streaming
  window, so latency hides inside work already happening.

**Consequence for Apex Code:** keep Pi's loop structure; add these behaviors (Phase 1, 3).

## Finding 3 — the safety floor is Pi's largest gap

Pi ships no permission system and, by explicit design, no sandbox; its own security
documentation states that project trust is a guard on *loading* configuration and
constrains nothing once a turn runs. The reasoning given — that a partial in-process
sandbox is worse than none because it is misread as a boundary — is sound, and Apex Code
adopts it as the framing for what its own sandbox must honestly claim.

`c-code` demonstrates the shape of a real answer:

- rules of the form *(source, behavior ∈ {allow, deny, ask}, tool, optional rule
  content)*, where the **rule content is interpreted by the tool itself** — so
  tool-specific matching never accumulates in the rule engine;
- a strict precedence order across roughly eight rule sources, from managed policy
  down to session-scoped;
- permission updates modeled as typed, persisted operations against explicit
  destinations, rather than ad-hoc settings writes;
- several distinct modes (default, plan, accept-edits, bypass, don't-ask);
- OS-level enforcement underneath: filesystem read/write restriction, network host
  allowlisting, a violation store, and an interactive escalation callback.

Atomic's settings show the ecosystem patching this gap with a third-party
permission-gate extension — which is evidence of the need, not a substitute.

**Consequence for Apex Code:** Phase 2, and it gates the tool surface.

## Finding 4 — context engineering is what makes a large tool surface affordable

Two techniques observed in `c-code`, neither present in Pi:

**Tool-result eviction.** Old tool results are dropped in place — replaced with a
short marker — for a whitelist of tools whose output is reproducible on demand (file
reads, shell, search, glob, web fetch and search, edit, write). It reclaims the bulk
of context cost with no summarization call and no loss of conversational structure.
This is the highest-value context technique in the review.

**Deferred tool schemas.** Tools are announced by name only; the full parameter
schema loads on demand through a search tool. MCP-provided tools default to deferred,
with an always-load override. This is what makes a forty-tool surface affordable at
all.

Pi's compaction (walk back to a recent-token budget, summarize, record the first kept
entry, reload) is solid, and its **branch summarization** on tree navigation is
something `c-code` has no equivalent for — a direct benefit of the better session
format.

**Caveat to carry into implementation:** eviction interacts with prompt caching.
Evicting a cached prefix can cost more than it saves, so cache hit rate belongs in
the Phase 3 gate, not in a follow-up.

**Consequence for Apex Code:** Phase 3, before Phase 4.

## Finding 5 — Pi's session format is the best of the five

JSONL, one entry per line, entries linked by `id`/`parentId` into a tree so branching
happens in place without new files. Versioned, with automatic migration on load
(v1 → v2 → v3 observed). Every state change is an entry — model changes,
thinking-level changes, service-tier changes interleaved with messages — so a session
replays exactly. `/tree`, fork, clone, and branch summarization all fall out of this.

Prime extends it usefully: git provenance in the session header (repo URL, commit,
branch), a recursion-depth field for nested delegation, per-subagent artifact
directories, and session leases for multi-client attach.

**Consequence for Apex Code:** keep the format; it becomes a compatibility promise once
distributed (ADR 0006, Phase 6). It is also what makes the Phase 0 replay corpus
possible.

## Finding 6 — the two mature forks show what production state infrastructure looks like

**OMP** moved durable state into SQLite: a credential store with per-credential
blocking, refresh leases, and identity keys (i.e. credential pooling with failover);
a table of measured per-model latency (time-to-first-token and generation time), which
makes routing a measurement problem rather than a guess; usage and cost history;
full-text prompt history; a separate embedded index for search; and a daemon that
multiple clients attach to. It also carries model *roles* — distinct models bound to
distinct jobs (default, plan, cheap, design) — which is the correct provider-agnostic
answer to "which model for which task."

**Prime** invested in durability: daemon workers with a command journal and snapshot
cache, so a long-running command survives a restart; session leases; and a persistent
Python kernel whose state is serialized between turns.

**Consequence for Apex Code:** Phases 1, 6, 8.

## Finding 7 — no reviewed harness can distinguish a claim from a result

Thanos is the exception, and the only one. It models evidence as a discriminated
union — diffs (paths, base, patch hash), test runs (runner, normalized executable,
argv, exit code), commands (risk family, argv, exit code), manual attestations, and
workflow artifacts with content hashes — and gates task completion on it.

Its most valuable property is not the model but the calibration: field data showed
that the overwhelming majority of recorded gate failures came from a handful of
template-generated criteria that no user had written, and the gate was narrowed to
exclude them. That is the standard Apex Code's phase gates are held to.

Its structural limit is that, as an extension, it can only observe tool results after
the fact and reconstruct what happened.

**Consequence for Apex Code:** capture evidence at the source, in core; keep the policy
layer a bundled, switchable extension (ADR 0007, Phase 7).

## Finding 8 — terminal UI

Pi's TUI has two runtime dependencies. `c-code`'s is a React-based terminal renderer
spanning several hundred components — pleasant to author, expensive to start, and the
single largest copy-temptation in that tree.

OMP's UI *configuration* is worth carrying: an ASCII symbol preset, a colorblind
mode, configurable token-usage display, and status-line presets. Cheap accessibility
work that almost nobody does.

**Consequence for Apex Code:** keep `pi-tui` (ADR 0001); adopt the accessibility settings
(Phase 8).

## Incidental finding — credential hygiene

A live provider API key was found in cleartext in two separate installed
configurations. One of those systems had already moved credentials into a database
table while leaving a plaintext copy in its model configuration file.

**Consequence for Apex Code:** keys come from the credential store or the environment,
never from a config file the loader writes. This is a Phase 1 exit criterion and a
`SECURITY.md` in-scope item.
