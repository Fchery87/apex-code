# Cross-phase contracts

Interfaces that **more than one roadmap phase writes to**. They cannot be designed
inside any single phase's spec, because the phase that defines them is never the only
phase that consumes them.

This document is permanent and grows one section per contract. A contract is either
**settled** (specified here, with an ADR) or **open** (consumers and questions
recorded, decision deferred to the phase that first writes to it). Nothing here is
speculative design for its own sake — a contract earns a place only when skipping it
would force a retrofit.

| Contract | Status | Consumers | Settle by |
| --- | --- | --- | --- |
| Tool contract | **Settled** — ADR 0010 | Phases 2, 3, 4, 5, 7 | Now (gates Phase 2's spec) |
| Context pipeline order | **Settled** — spec `2026-08-13-context-engineering` | Phases 3, 7 | Settled 2026-08-13 |
| Session entry schema | Settled — ADR 0006 | Phases 1, 5, 6, 7, 9 | — |

---

# 1. Tool contract — settled

## Why this is a contract and not a Phase 2 detail

Upstream `ToolDefinition` (`core/extensions/types.ts:335`) carries `name`, `label`,
`description`, `promptSnippet`, `promptGuidelines`, `parameters`, `renderShell`,
`prepareArguments`, `executionMode`, `execute`, and two renderers. It carries nothing
about permissions, evictability, deferrability, capability class, or evidence.

Four phases each need to add to that one interface:

| Phase | What it needs from every tool |
| --- | --- |
| 2 Permissions | how the tool interprets its own `ruleContent` |
| 3 Context | whether its result is recoverable (evictable), whether its schema defers |
| 5 Delegation | its capability class, for ceiling enforcement |
| 7 Evidence | what evidence it emits, and in what shape |

Phase 4 builds roughly fifteen tools. If those four axes are designed independently
in four different phase specs, every tool is reopened three more times after it
ships. That is the same retrofit the roadmap already avoids for permissions,
multiplied.

There is direct precedent for the failure. The predecessor harness's ADR 0021 exists
because tool capability and risk classification were derived once for authorization
and separately re-derived wherever a human needed to see them; the two disagreed, and
a real registered tool fell through both classifiers entirely. The fix was one
canonical source projected into every consumer. This contract is that source,
established before the divergence rather than after.

## Shape

The whole shape is settled now. Each field's **consumer** lands in its own phase —
Phase 2 implements the rule engine that reads `permission`, Phase 7 implements the
ledger that reads `evidence`. Tools written in Phase 4 declare all four sections up
front, so Phases 5 and 7 consume declarations that already exist.

```ts
/** Apex Code extends upstream ToolDefinition with exactly one required field. */
export interface ApexToolDefinition<TParams extends TSchema, TDetails = unknown>
  extends ToolDefinition<TParams, TDetails> {
  contract: ToolContract<TParams, TDetails>;
}

export interface ToolContract<TParams extends TSchema, TDetails> {
  capabilities: ReadonlySet<Capability>;
  permission: PermissionSpec<TParams>;
  context: ContextSpec;
  evidence: EvidenceSpec<TParams, TDetails>;
}
```

`contract` is **required**, and every sub-field is required. That is the design's
whole load-bearing property: a new tool cannot compile without answering all four
axes, so it cannot silently default into "unclassified." Optionality here would
reintroduce exactly the gap ADR 0021 closed.

### 1.1 `capabilities`

```ts
export type Capability =
  | "fs.read"      // reads files or directory structure
  | "fs.write"     // creates, modifies, or deletes files
  | "exec"         // runs a subprocess
  | "net"          // makes an outbound network request
  | "delegate"     // starts or controls another agent
  | "ui"           // solicits input from the human
  | "state";       // mutates harness state outside the workspace
```

A **set**, not a single value: `bash` is `{exec}` and, because a subprocess can do
anything, is treated as implying the rest at enforcement time — see below.

Two consumers. Phase 5 enforces the **capability ceiling**: a delegated agent's
capability set must be a subset of its parent's, checked at delegation time rather
than at each call. Phase 2 uses the set as the coarse input to default behavior
(§1.2).

**The `exec` escalation rule.** A tool with `exec` can reach every other capability
through the subprocess it spawns. Enforcement therefore treats `exec` as implying the
full set for ceiling purposes. This is stated here rather than discovered in Phase 5,
because the alternative — a parent without `fs.write` delegating to a child with
`exec` — is a ceiling bypass that looks correct in the type system.

### 1.2 `permission`

The key property, carried forward from the research: **`ruleContent` is interpreted
by the tool, not by the rule engine.** That is what keeps tool-specific matching out
of the engine, and it means the engine can stay small while `Bash(git commit:*)` and
`Read(~/.ssh/**)` mean entirely different things.

```ts
export interface PermissionSpec<TParams extends TSchema> {
  /** Behavior when no rule matches. Read-only tools may default to "allow". */
  defaultBehavior: PermissionBehavior;   // "allow" | "deny" | "ask"

  /** Does this call match this rule's content? The tool owns the grammar. */
  matches(ruleContent: string, params: Static<TParams>): boolean;

  /** Human-readable rendering of a rule, for prompts and `/permissions`. */
  describe(ruleContent: string): string;

  /**
   * The rule that would allow this exact call — what "always allow this"
   * persists. Return null when the call is not generalizable into a rule.
   */
  ruleForCall(params: Static<TParams>): string | null;
}
```

`ruleForCall` is not a convenience. Without it, "always allow this" is implemented by
each permission prompt inventing its own rule string, which is a second, informal
grammar drifting alongside `matches`. One tool owns both directions or neither.

`describe` exists so a denial can explain itself. A permission system users cannot
read is one they will disable.

### 1.3 `context`

```ts
export interface ContextSpec {
  /**
   * True when the result's information is recoverable — the same content can be
   * obtained again by re-running the tool or reading the workspace.
   *
   * ONLY recoverable results may be evicted. A tool whose result cannot be
   * regenerated (a user's answer, a timestamped or nondeterministic command,
   * a consumed one-shot resource) must set this false, or eviction silently
   * destroys information the transcript is the only record of.
   */
  resultRecoverable: boolean;

  /** Marker substituted for an evicted result. */
  evictionMarker?: string;

  /** Announce by name only; load the parameter schema on demand. */
  deferSchema: boolean;

  /** Soft cap on result tokens before truncation. */
  outputBudgetTokens?: number;
}
```

`resultRecoverable` is the eviction predicate, and it is deliberately phrased as a
property of the *information* rather than a whitelist of tool names. A whitelist is a
list someone forgets to update; a required boolean is a question every new tool must
answer.

**Correctness note carried from research Finding 4:** eviction invalidates any prompt
cache prefix it touches, and can cost more than it saves. That is a pipeline-ordering
concern, not a per-tool one — see Contract 2.

### 1.4 `evidence`

```ts
export interface EvidenceSpec<TParams extends TSchema, TDetails> {
  /** Kinds this tool can emit. Empty set is valid and explicit. */
  emits: ReadonlySet<EvidenceKind>;   // "diff" | "test" | "command" | "manual" | "workflow" | "diagnostic"

  /**
   * Derive evidence from a completed call. Runs inside the tool's own execution
   * path, with access to what actually happened — the exit code, the patch hash,
   * the argv — not a reconstruction from rendered output.
   */
  capture(
    params: Static<TParams>,
    result: AgentToolResult<TDetails>,
  ): EvidenceRecord[];
}
```

This is the field that justifies moving evidence into core at all. An extension
observing `tool_result` can only parse what was rendered; the bash tool already holds
its exit code as a number. `capture` runs where that number lives.

`"diagnostic"` records follow the same rule. Mutation tools capture the selected server,
bounded total and severity counts, and whether the collector truncated its result.
Diagnostic messages and free-form failure reasons are presentation data and may contain
source or server-controlled text, so they never enter durable evidence. See ADR 0020.

## Foreign tools

MCP servers and third-party extensions register tools that cannot supply a contract.
They are not rejected, and they are not silently defaulted either — both are how the
ADR 0021 bug happened.

```ts
export const UNCLASSIFIED: ToolContract<TSchema, unknown> = {
  capabilities: ALL_CAPABILITIES,          // assume the worst
  permission: { defaultBehavior: "ask", /* exact-argument matching only */ },
  context: { resultRecoverable: false, deferSchema: false },
  evidence: { emits: new Set(), capture: () => [] },
};
```

Conservative on every axis: full capability set (so it cannot widen a ceiling),
`ask` by default, never evicted, schema fully announced, emits nothing.

And it must be **visible**. Any tool carrying `UNCLASSIFIED` is reported as
unclassified by the projection below and shown as such in `/tools` and `/doctor`. A
conservative default that nobody can see is indistinguishable from a bug.


**Phase 4 amendment (2026-08-13):** `UNCLASSIFIED.context.deferSchema` is `false`.
Foreign/MCP tools remain fully announced because they do not participate in the
first-party schema-load protocol; the fallback is still conservative on every
security and retention axis. ADR 0011 settles the explicit load path and its shared
fallback consumption.

## One projection, never re-derived

Exactly one function reads the registry and projects contracts for every consumer
that needs to *describe* rather than *enforce*:

```ts
export function buildToolContractSnapshot(
  tools: readonly ApexToolDefinition<TSchema>[],
): ToolContractSnapshot;   // read-only
```

`/tools`, `/doctor`, generated reference docs, and the drift test all consume this
snapshot. It is a **projection, not a second authorization engine** — it calls the
same predicates the permission engine calls and never re-implements their logic, and
nothing it produces is an authorization input.

A future surface that needs to describe the tool surface consumes this snapshot. A
second independent classification is the exact drift this contract closes; it is not
a pattern to repeat for a new consumer.

## Enforced invariants

Each is a test, not a convention:

1. Every registered tool has a `contract`; foreign tools carry `UNCLASSIFIED` and are
   reported as unclassified.
2. Every tool invocation passes the permission gate. **No exceptions list** — the
   test enumerates the registry, not a hand-maintained set.
3. No tool with `resultRecoverable: false` is ever evicted.
4. A delegated agent's capability set is a subset of its parent's, with `exec`
   expanded per §1.1.
5. `matches(ruleForCall(p), p)` is true for every tool and every representative `p`.
   The two directions of the grammar cannot drift apart.
6. `/tools`, `/doctor`, and generated docs derive from `buildToolContractSnapshot()`
   and from nothing else.

Invariant 5 is the cheapest high-value test here: it is a property, it applies to
every tool automatically, and it catches the class of bug where a generated rule does
not actually authorize the call it was generated from.

## Phasing

| Phase | Lands |
| --- | --- |
| 2 | `ToolContract` type; `permission` consumed by the rule engine; invariants 1, 2, 5 |
| 3 | `context` consumed by eviction and deferred schemas; invariant 3 |
| 4 | All new tools declare full contracts; `buildToolContractSnapshot()`; invariant 6 |
| 5 | `capabilities` consumed by ceiling enforcement; invariant 4 |
| 7 | `evidence.capture()` consumed by the ledger |

The seven upstream-inherited tools are backfilled with contracts in Phase 2 — seven
declarations, written once, against a shape that does not move afterward.

---

# 2. Context pipeline order — settled

**Settled:** 2026-08-13, in `docs/specs/2026-08-13-context-engineering.md`.
**Consumers:** Phases 3, 7.

Compaction, tool-result eviction, and deferred-schema resolution all rewrite the
message list at one seam (`transformContext`). Their ordering has correctness
consequences that no single phase can settle alone.

**The order is:**

```
deferred-schema resolution → tool-result eviction → compaction (threshold or reactive)
```

Schema resolution runs first because it changes the static prefix that both later
stages measure themselves against.

The four questions this contract was opened to answer:

- **Eviction before or after compaction?** **Before.** Compaction is the expensive,
  lossy, irreversible stage — it makes a summarization call and replaces structure
  with prose. Eviction is cheap and structure-preserving, so running it first means
  compaction is reached later, less often, and over a shorter transcript. The
  objection that compaction then summarizes markers is real but bounded: only
  `resultRecoverable: true` content is ever behind a marker, so anything the summary
  loses is by construction regenerable.
- **Prompt-cache interaction.** Eviction removes a contiguous run from the **oldest**
  end only, never a hole in the middle, so the cache boundary moves forward
  monotonically instead of invalidating everything after a gap. This was decided on
  structural grounds because the corpus could not measure it: every fixture recorded
  `cacheRead`/`cacheWrite` of 0, making `cacheHitRate` a constant zero.
  `long-tool-heavy.jsonl` fixed that half — it carries real cache usage
  (`cacheHitRate` 0.8569) — but a second gap surfaced once eviction was actually wired
  into the replay harness and this was checked for real (2026-08-13): `cacheHitRate`
  is computed from each fixture's *recorded* assistant-message usage, baked in at
  authoring time, and never reacts to what eviction actually sends outbound. Measured
  directly: running `long-tool-heavy.jsonl` with eviction disabled versus enabled
  produces the *identical* `cacheHitRate` (0.8569384835479256) even though turn-20
  tokens drop from 15,272 to 1,769. The offline replay harness replays pre-recorded
  responses rather than simulating a live, cache-aware provider, so a pre/post
  comparison is not merely unmeasured — it is structurally incapable of detecting
  anything, and this is true regardless of implementation quality. **Prefix-oldest
  eviction therefore remains a structural decision, not a measured one — the
  reasoning above (monotonic cache boundary vs. a scattered pattern) is the entire
  basis for it. There is no ADR trigger here, because there is no measurement that
  could contradict it: an ADR fires on a contradicting result, and this harness
  cannot produce a result of either kind.** Real cache-impact validation (a live
  provider, or a simulated prefix-match metric) is a stated follow-up for a later
  phase, not a Phase 3 blocker.
- **Evidence survival (Phase 7 constraint).** Satisfied by construction: eviction
  rewrites only the outbound provider context and never the stored session. Phase 3
  carries a test asserting the on-disk session is byte-identical before and after an
  eviction pass, so a future evidence path that reads back from message content fails
  loudly here rather than silently in Phase 7.
- **Determinism.** Eviction is a pure function of (message list, per-tool
  `ContextSpec`, token budget) — no clock, no randomness, no I/O. Time-based eviction
  is explicitly a Phase 3 non-goal, so no injectable clock is required and the replay
  gate's identical-metrics requirement holds.

# 3. Session entry schema — settled

**Decision:** ADR 0006. **Consumers:** Phases 1, 5, 6, 7, 9.

Sessions use the versioned native-v3 JSONL format settled by ADR 0006. Entries are
append-only and linked by `id`/`parentId`; new entry types are additive and carry a
`type` discriminator. Readers ignore unknown entry types. Removing an entry type or
changing a field's meaning requires a format-version bump and migration.

Current Apex additions preserve that contract: the session header may contain the
optional `delegationDepth` field (absent means zero), and Phase 7 adds the `evidence`
entry type with bounded structured facts and optional session-owned artifact
references. ADR 0006 is authoritative for compatibility and migration rules.
