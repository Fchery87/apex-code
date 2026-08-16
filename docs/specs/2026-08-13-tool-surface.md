# Spec: Tool surface — second-wave tools, their rule grammars, and the deferred-schema load path

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Status | `Active` |
| Created | `2026-08-13` |
| Last updated | `2026-08-13` |
| Roadmap phase | `4 — Tool surface` |
| Tracking issue/PR | none |
| Compatibility posture | **Preserves compatibility.** See below. |

**Compatibility posture.** Every existing tool keeps its name, schema, default
behavior, and `ruleContent` grammar, so a `settings.json` written before this change
resolves identically after it. The session format is untouched. New tools are additive
to `createAllToolDefinitions`, and new settings keys ship with defaults that leave a
non-configuring user where they are today.

Two obligations follow from that posture and are load-bearing rather than incidental:

1. **Deferral and the load path ship together, never separately.** Setting
   `deferSchema: true` on a tool today makes that tool unusable (see The problem), so
   no tool in this phase defers until the load path lands and is tested. This is
   sequencing, not preference.
2. **Adding a `net` tool does not widen the sandbox.** The Linux sandbox's deny-all
   network posture (spec `2026-08-12-os-sandbox.md`, ADR 0005) is a boundary this
   phase consumes, not one it relaxes. A `net` tool that runs outside the sandbox and
   a sandboxed child that still cannot reach the network are the same system, and the
   spec says which side each tool is on.

## Executive summary

Phase 4 roughly doubles the tool surface — a schema-load path, `TodoWrite`, web search
and fetch, plan-mode presentation, structured user questions, and the delegation entry
point Phase 5 builds out — and it does so without doubling the static prompt prefix.
The mechanism that makes that possible is Phase 3's deferred-schema projection, which
today has an announce side wired into every request and **no load side wired into
anything**: `loadDeferredSchema` exists and is tested, but no production code calls it.
Building that load path is therefore the first task of the phase and the precondition
for every tool that follows. Along the way this phase supplies the first real
implementor for four of the seven declared capabilities (`net`, `delegate`, `ui`,
`state`), which have been declared and enforced against but never exercised.

## Context and motivation

- `docs/roadmap.md`, Phase 4 — the phase this serves, including the exit criterion
  this spec revises (see The problem, item 2).
- `docs/architecture/contracts.md` § 1 (Tool contract — settled) and ADR
  `0010-one-canonical-tool-contract.md` — the four axes every tool here declares.
  contracts.md already anticipates this phase by name: *"Phase 4 builds roughly fifteen
  tools… Tools written in Phase 4 declare all four sections up front, so Phases 5 and 7
  consume declarations that already exist."*
- `docs/architecture/contracts.md` § 2 (Context pipeline order — settled) and
  `docs/specs/2026-08-13-context-engineering.md` — the deferred-schema mechanism whose
  consumer this phase supplies. That spec's `systemPromptTokens` goal is recorded as
  **"Unmet by design"** precisely because Phase 3 had no tool worth deferring; this
  phase is where that resolves.
- `docs/specs/2026-08-11-permission-rule-model.md` and ADR
  `0004-permission-rule-model.md` — the rule engine each new tool plugs a grammar into.
- `docs/specs/2026-08-12-os-sandbox.md` and ADR `0005-sandbox-boundary-guarantees.md` —
  the deny-all network posture the two `net` tools must be reconciled against.

## Current state

**Seven tools, all with full contracts, none deferring.** The registry
(`packages/coding-agent/src/core/tools/index.ts:156`) is `read`, `bash`, `edit`,
`write`, `grep`, `find`, `ls`. Every one declares all four contract axes, and
registry-wide tests (`test/permissions/contract.test.ts`,
`test/permissions/gate-universal.test.ts`) enumerate them by name so a new tool cannot
be added silently. All seven set `deferSchema: false`.

**The static prefix is almost entirely tool schemas.** Measured with the same formula
the replay harness uses (`ceil(length / 4)`, `metrics.ts:49`), against
`createAllToolDefinitions` and `buildSystemPrompt`:

| Slice | Tokens |
| --- | --- |
| System prompt text | 28 |
| Tool schemas (7 tools) | 1,189 |
| **Production static prefix** | **1,217** |

Per tool, and what announce-by-name would cost instead:

| Tool | Full schema | Announced (name + description + stub) | Saved |
| --- | --- | --- | --- |
| `edit` | 287 | 102 | 185 |
| `grep` | 252 | 75 | 177 |
| `read` | 164 | 96 | 68 |
| `find` | 147 | 67 | 80 |
| `bash` | 128 | 82 | 46 |
| `ls` | 111 | 66 | 45 |
| `write` | 100 | 52 | 48 |
| **Total** | **1,189** | **540** | **649** |

Two facts fall out of that table and drive most of this spec's design. Schemas are
97.7% of the static prefix, so the deferred-schema mechanism targets the dominant term
rather than a rounding error. And a deferred tool still costs ~45% of a full one,
because its `description` is retained by design (`announceToolsByName`,
`deferred-schemas.ts:79`) — deferral compresses the surface, it does not make a tool
free.

**The replay corpus's 707 is a four-tool number, not a production one.**
`productionPromptAndSchemas` (`testing/replay/runner.ts:242`) selects
`["read", "bash", "edit", "write"]` plus whatever tools a fixture actually recorded. So
`systemPromptTokens: 707` in `test/replay-runner.test.ts:230` measures four tools, and
adding tools to the registry will not move it. The corpus cannot see this phase's
growth.

**The load path has no production caller.** `announceToolsByName` is wired through
`projectToolSchemas` into `installContextPipeline` (`core/context/pipeline.ts:121`) and
runs on every request. `loadDeferredSchema` (`deferred-schemas.ts:102`) is called only
from `test/context/deferred-schemas.test.ts`.

**Review decisions before implementation.** Grounding exposed three points that must
not remain open in the plan. First, "loaded" means that the model-callable schema tool
returns the real schema as a tool result; it does not mutate the already-issued tool
list. The end-to-end proof therefore has two provider requests: schema-tool call, then
a valid call to the deferred tool. Second, the canonical absent-contract fallback keeps
foreign/MCP tools fully announced: `UNCLASSIFIED.context.deferSchema` is changed to
`false`, and both the permission gate and context projection consume that same fallback.
Foreign tools remain conservative (`ask`, all capabilities, never evicted, no evidence)
without silently changing their schema behavior. Third, plan mode's hard floor denies
filesystem writes, execution, and delegation, but permits explicit harness-state tools
such as `todo_write`; otherwise plan mode cannot maintain the plan it is presenting.
These are compatibility and usability decisions, not implementation details.

**Four capabilities have no implementor.** `Capability` declares `fs.read`, `fs.write`,
`exec`, `net`, `delegate`, `ui`, `state` (`core/tools/contract.ts:15`). Only the first
three are used. `resolveWithMode` (`core/permissions/modes.ts:19`) already classifies
`fs.write`, `exec`, `delegate`, and `state` as mutating for plan mode's hard floor, and
`isEditShaped` already excludes `net`, `delegate`, and `state` from `acceptEdits` — so
mode behavior for the unused four is written and enforced but has never met a real tool.

**Plan mode exists; a plan-mode tool does not.** `mode === "plan"` is a permission mode
that denies mutating capabilities (`modes.ts:44`). There is no tool by which an agent
presents a plan or leaves the mode.

This is all Apex Code's own code, not upstream Pi's, except the seven tools' execution
bodies — the contract blocks, the permission gate, the modes, and the context pipeline
are fork-local (ADR 0003 merge-cost note: adding tools alongside them adds no upstream
conflict surface).

## The problem

**1. Deferral is announce-only, so `deferSchema: true` is currently a trap.** A tool
that sets it is announced to the model with `{"type":"object","properties":{}}` and no
mechanism by which the model can ever learn its real parameters. The model would either
skip the tool or invent arguments that fail schema validation. The primitive that
closes this (`loadDeferredSchema`) was built in Phase 3 and deliberately left unwired —
the context-engineering spec's non-goals name an on-demand schema tool as "Phase 4's
problem." This is that problem, and it blocks every other item in the phase, because a
tool surface that grows without deferral is the growth this phase is supposed to avoid.

**2. The exit criterion, read literally, is arithmetically unreachable.** The roadmap
says the total system-prompt token count must stay "under the ceiling established in
Phase 3." Phase 3 established 1,217 (production) or 707 (the corpus's four-tool
figure), with nothing deferred. This phase adds roughly seven tools. Announced-only,
using the measured ~77-token average for a name-plus-description entry, those cost
about +540 — which lands near 1,760 before a single schema is included, already above
either ceiling. Reaching 1,217 exactly would require deferring the default tools too,
and `read`/`bash`/`edit`/`write` are excluded from deferral by an explicit standing
decision. The criterion needs restating as a real budget, with the arithmetic on the
record, rather than being carried forward as a number no implementation can hit.

**3. Two seams disagree about what an absent contract means.** At the permission gate,
a tool with no contract resolves to `UNCLASSIFIED` (`gate.ts:49`), whose `context` sets
`deferSchema: true`. At the context pipeline, a tool absent from the contract lookup is
treated as `deferSchema: false` (`pipeline.ts`, `projectToolSchemas`). Both defaults
are individually defensible today — and the pipeline's is what keeps MCP and extension
tools working, since deferring them without a load path would break them — but they are
two independent derivations of one classification, which is the exact failure mode
contracts.md cites ADR 0021 to avoid. The load path is what removes the reason for the
divergence, so this phase is where it must be reconciled rather than inherited.

**4. Four capabilities are enforced but unexercised, and one interaction is wrong.**
`state` is classified as mutating, and the current plan-mode floor denies it outright.
`TodoWrite` is the natural `state` tool and planning is exactly when it is most useful.
Phase 4 therefore narrows the hard floor to filesystem writes, execution, and
delegation; explicit harness-state tools remain callable in plan mode and are covered by
mode tests.

## Goals

- [ ] A tool with `deferSchema: true` can be discovered, its schema loaded on demand,
      and then called with valid arguments — proven end-to-end through a real
      `AgentSession` (`createHarness`), not at the primitive level.
- [ ] Every tool added in this phase declares all four contract axes, and the
      registry-wide tests in `test/permissions/contract.test.ts` and
      `test/permissions/gate-universal.test.ts` enumerate it — a new tool still cannot
      be added silently.
- [ ] Every tool added in this phase has a `ruleContent` grammar with `matches`,
      `describe`, and `ruleForCall` tested, including at least one negative case per
      tool (a rule that must *not* match a call it superficially resembles). Where a
      call is genuinely not generalizable, `ruleForCall` returns `null` and a test
      asserts that, rather than a grammar being invented to fill the slot.
- [ ] A test measures the production static prefix directly from
      `createAllToolDefinitions` + `buildSystemPrompt` and asserts it stays under a
      stated budget. The budget is a real measured number fixed by task 4.1, not the
      corpus's 707 — which, per Current state, cannot observe this phase at all.
- [ ] Each of `net`, `delegate`, `ui`, and `state` has at least one real implementor,
      and each has a test asserting its behavior under `plan`, `acceptEdits`, and
      `dontAsk` modes.
- [ ] The `UNCLASSIFIED`-vs-pipeline disagreement on absent contracts is resolved to a
      single derivation, with a test that fails if the two seams diverge again.
- [ ] Both `net` tools state and test which side of the sandbox boundary they execute
      on, with a test that a sandboxed child still cannot reach the network.

## Non-goals

- [ ] **LSP is deferred to its own spec.** It is not a tool but a subsystem — server
      discovery, process lifecycle, per-language configuration, and a document-sync
      model — and folding it in here would produce a spec whose largest section shares
      nothing with the rest. It stays in Phase 4's roadmap scope and gets
      `docs/specs/YYYY-MM-DD-lsp.md` when the tools below are landed.
- [ ] **Delegation execution is Phase 5's.** This phase ships the entry point's
      contract, capability declaration, and rule grammar so Phase 5 has a declared
      surface to enforce a ceiling against. It does not ship subagent spawning,
      recursion depth guards, or artifact isolation, which the roadmap assigns to
      Phase 5 and which depend on `pi-subagents` primitives not yet vendored.
- [ ] **No default tool defers its schema.** `read`, `bash`, `edit`, and `write` keep
      `deferSchema: false`. They are called on nearly every task, so deferring them
      trades a one-time prefix saving for a per-session extra round trip, and the
      decision to exclude them is already settled. `grep`, `find`, and `ls` are
      candidates and are evaluated by measurement in task 4.1, not assumed.
- [ ] **MCP and extension tools do not gain deferral defaults here.** They continue
      passing through with real schemas. The canonical absent-contract fallback is
      conservative for permission/capability/evidence/eviction, but deliberately does
      not alter the provider-facing schema for third-party tools.
- [ ] **The replay corpus is not re-recorded.** The static-prefix gate gets its own
      direct test instead. Re-recording fixtures so a context change looks good would
      destroy the only baseline the phase is measured against — the same reasoning
      Phase 3 applied.

## Proposed solution

### The load path (task 4.1, blocking)

A model-callable meta-tool that returns the real parameter schema for a named tool,
backed by `loadDeferredSchema`. The model sees every deferred tool's name and
description in the static prefix, decides which it needs, calls the meta-tool, and
then calls the real tool with valid arguments.

An explicit tool rather than automatic injection, because the model needs the schema to
*construct* a call — by the time a deferred tool's call arrives, the arguments are
already wrong, so there is no seam at which the harness could inject the schema in
time. This is an irreversible interface decision (it becomes part of the model-facing
surface and every deferred tool's usability depends on it), settled by ADR 0011.

| Component | Change | File(s) |
| --- | --- | --- |
| Schema-load tool | New tool wrapping `loadDeferredSchema` over the live registry | `core/tools/tool-schema.ts` (new) |
| Registry | Add to `ToolName`, `allToolNames`, and the `createAllTool*` factories | `core/tools/index.ts` |
| Absent-contract default | One `UNCLASSIFIED` fallback shared by `gate.ts` and `pipeline.ts`; foreign schemas remain fully announced | `core/tools/contract.ts`, `core/context/pipeline.ts`, `core/permissions/gate.ts` |
| Prefix budget test | Measure `createAllToolDefinitions` + `buildSystemPrompt`, assert budget | `test/context/static-prefix.test.ts` (new) |

The schema-load tool itself must never defer (it would be unreachable) and must be
callable in every permission mode including `plan`, so it declares an empty capability
set — legal, and `isMutating` on it is correctly `false`. It performs no external I/O
and has no workspace side effects; `defaultBehavior` is `allow` and `ruleForCall`
returns `null`, since "allow reading the schema of tool X but not tool Y" is not a
distinction worth a grammar. It only returns schemas for tools in the live active
registry and rejects unknown names; it does not expose inactive or extension-private
registrations.

### The tools

Each row is a full contract declaration. `Defer` is the *intended* setting, confirmed
against the measured budget in task 4.1 — a tool whose announced form saves less than
it costs in round trips does not defer just to be consistent.

| Tool | Capabilities | Default | `ruleContent` grammar | Defer | Evidence |
| --- | --- | --- | --- | --- | --- |
| schema load | *(none)* | allow | `ruleForCall` → `null` | no | none |
| `todo_write` | `state` | allow | `ruleForCall` → `null` | yes | none |
| `web_search` | `net` | ask | `ruleForCall` → `null`; only `*` is meaningful | yes | none |
| `web_fetch` | `net` | ask | host + path glob (`docs.example.com/**`) | yes | none |
| `plan_present` | `ui` | allow | `ruleForCall` → `null` | no | `workflow` |
| `ask_user` | `ui` | allow | `ruleForCall` → `null` | yes | none |
| delegation entry | `delegate` | ask | agent-type glob (`explore:*`) | yes | `workflow` |

`web_search` gets no invented grammar. `PermissionSpec.ruleForCall` already documents
`null` as the answer for a call that is not generalizable, and a query-substring
grammar would be security theater — an allow-rule matching a query substring authorizes
nothing meaningful about what the search returns. The real control for search is the
`net` capability and its default of `ask`.

Worktree isolation is specified as a property of the delegation entry point rather than
a standalone tool: it is an execution-context boundary for a delegated child, and there
is no coherent call for "make a worktree" that is not a delegation. It is declared here
so Phase 5's isolation work has a surface to attach to.

### Seam invariants

This touches two seams named in `docs/architecture/overview.md`. `beforeToolCall`: every
new tool passes through the same `evaluateToolCall` path, so the gate stays
tool-agnostic and no tool interprets its own permission result. `transformContext` /
the deferred-schema stage: the load path reads the same registry that
`projectToolSchemas` projects from, so a tool cannot be announced from one source and
loaded from another — that shared source is what makes the ADR 0021 failure mode
structurally impossible here rather than merely avoided.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `contract.test.ts`'s "covers exactly the seven inherited tools" | test | Superseded — same no-silent-omission property, restated over the grown registry |
| `gate-universal.test.ts`'s `REPRESENTATIVE_PARAMS` seven-key map | test | Superseded — extended, and its exhaustiveness assertion kept |
| `pipeline.ts`'s independent absent-contract default | behavior | Superseded by the shared `UNCLASSIFIED` fallback; its full-schema behavior remains |
| `2026-08-13-context-engineering.md`'s `systemPromptTokens` "Unmet by design" row | doc | Superseded — amended in place to cite this phase's measured result |
| Roadmap Phase 4's "under the ceiling established in Phase 3" exit criterion | doc | Superseded by the measured budget from task 4.1, with the arithmetic recorded |

No tool, setting, or session-format field is removed. The phase is additive to the
registry by construction; everything retired above is a doc or test statement that this
phase makes false, and each is replaced rather than dropped.

## Risks

**A deferred tool the model never loads.** The model sees a name and description, judges
the tool irrelevant or guesses arguments, and the tool is effectively dead. This is the
central risk of the whole mechanism and it degrades silently — nothing errors, the model
just does worse work. Signal: a corpus-level assertion on tool-call schema-validation
failures, plus a harness test that a deferred tool is actually reachable end-to-end.
Description quality carries real weight once a schema is withheld, which is an argument
for deferring fewer, larger-schema tools rather than everything.

**The load path costs a round trip.** Every first use of a deferred tool adds a
model turn. Deferring a tool that is called in most sessions trades a one-time prefix
saving for a recurring latency cost — the reason the default four are excluded. Signal:
turns-per-task across the corpus, which would rise if deferral is applied too broadly.

**`state` under plan mode.** If `TodoWrite` is denied in plan mode, either the
capability classification or the mode's floor is wrong. Signal: the mode-interaction
test required by Goals, which forces the question to be answered explicitly rather than
discovered by a user.

**`net` tools versus the sandbox.** A `web_fetch` that runs in the agent's own process
reaches the network while a sandboxed `bash` child cannot — a real and defensible
asymmetry, but one that is a boundary hole if it is accidental rather than stated.
Signal: an integration test asserting the sandboxed child still fails to reach the
network after these tools exist.

**Registry growth outpacing the contract tests.** The enumeration tests are the thing
standing between this phase and a tool that silently defaults into unclassified. Signal:
they fail loudly by construction — the risk is a future author weakening the assertion
rather than extending it, which review must catch.

## Verification

- `test/context/static-prefix.test.ts` (new) — production static prefix under budget,
  measured from `createAllToolDefinitions` + `buildSystemPrompt`. Baseline on record:
  **1,217 tokens** at seven tools (28 prompt + 1,189 schemas); naive projection with
  the phase's tools and no deferral is roughly **2,400**. Task 4.1 fixes the enforced
  budget from measured descriptions; the phase gate is that the deferred-schema
  mechanism absorbs the majority of the added schema cost, evidenced by the gap
  between the enforced number and that naive projection.
- `test/permissions/contract.test.ts`, `test/permissions/gate-universal.test.ts` —
  extended to the full registry; every tool declares four axes, defaults match
  capability class, no tool omitted.
- Per-tool rule-grammar tests — `matches` / `describe` / `ruleForCall`, each with a
  negative case.
- `test/permissions/modes.test.ts` — `net`, `delegate`, `ui`, `state` under `plan`,
  `acceptEdits`, `dontAsk`.
- A `createHarness` test — deferred tool announced without schema, schema loaded on
  demand, real call succeeds.
- Sandbox integration test — network still denied inside the sandboxed child.
- The existing corpus gates stay green and unmodified, including
  `systemPromptTokens: 707`, which by construction this phase does not move.

## Rollout

Needs `docs/plans/2026-08-13-tool-surface.md`: the work is roughly eight tools across
many files, task 4.1 is a hard blocker for everything after it, and the phase needs its
own status tracking to keep "tool shipped" distinct from "tool shipped with a rule
grammar and tests," which the roadmap explicitly counts as not done.

Needs one ADR, for the decision that deferred schemas are resolved through an explicit
model-callable tool rather than harness-side injection. It is irreversible in the sense
that matters — it lands in the model-facing surface, and every deferred tool's
usability routes through it. Settled as `docs/adr/0011-deferred-schema-load-path.md` and cited here.

Two items are carried as open questions for the plan rather than settled here, because
both need a measurement that does not exist yet: whether `grep`/`find`/`ls` defer, and
the enforced value of the static-prefix budget. Both are answered by task 4.1.

## Verified static-prefix measurement

Phase 4 completed with a 14-tool registry measuring 2,706 tokens without deferral,
2,150 tokens with the selected first-party deferrals, and an enforced ceiling of
2,300 tokens (`ENFORCED_PRODUCTION_PREFIX_BUDGET`). The deferred first-party set is
`grep`, `find`, `ls`, `todo_write`, `web_search`, `web_fetch`, `ask_user`, and
`delegate`; `tool_schema` remains always loaded.
