# Phase 5 delegation & multi-agent

**Status:** Not started — ADR 0008 accepted; task 5.1 is the blocking slice

This plan implements `docs/specs/2026-08-14-delegation-and-multi-agent.md` and ADR
`0008-delegation-authority.md`. Task 5.1 is the blocking correctness slice: the ceiling
function and the derived permission store are what make "a child cannot exceed its
parent" structural rather than incidental, and every task after it is tested against
them. No child agent executes before 5.1 lands, because a child that runs without a
derived store is the exact bypass this phase exists to close.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 5.1 Capability ceiling and derived permission store | Not started | — | Pure ceiling function over `(parentSet, requestedSet)` with `exec` expanded per `contracts.md` §1.1, returning either the child set or a refusal **naming the offending capability**; unit tests for subset, non-subset, `exec`-expansion (a parent holding `exec` admits any request), and the empty-parent edge. Derived store: `snapshot()` returns the parent's live snapshot — including the four runtime-only sources — merged with a child-local overlay; `apply()` writes only to the overlay and only for `session`/`command`. Tests: a `session`-source rule created in the parent is visible to the child (the real bypass from the spec's problem item 2), and a rule persisted in the child is absent from the parent's snapshot after the child completes (problem item 7). Both directions asserted through `evaluateToolCall`, not just at the store surface, so the proof is about decisions and not data structures |
| 5.2 Delegation runtime and `delegate` execution | Not started | — | `core/delegation/runtime.ts` builds a child `AgentSession` from the parent's services with the 5.1 ceiling and derived store; `delegate.execute` stops throwing and returns the child's result. Agent resolution enters through an injected resolver interface (a test fixture here, real discovery in 5.5), matching the `toolSchemaResolver`/`todoWriteStore` injection convention already used by Phase 4's tools. End-to-end proof through `createAgentSession`, not at the primitive level: parent delegates, a real child session runs a task, the result returns. Child tool list is derived **from the computed capability set**, never taken from the agent definition's list — tested by a definition naming `bash` under a parent without `exec`, which must not yield a child holding `bash` |
| 5.3 Recursion depth guard | Not started | — | `delegationDepth?: number` added to `SessionHeader` (absent means 0; additive-optional, no version bump, per `contracts.md` §3). Child depth = parent + 1, assigned by the runtime rather than by the tool so the bound applies to any future delegation entry point. Default bound 2, settings-configurable behind a hard cap. Tests: delegation at the bound is refused with a reason naming the bound; no child session and no artifact directory are created past it; a session written before this task (no field) reads as depth 0. Recorded in `contracts.md` §3's "Entry types added before Phase 6" table as it lands |
| 5.4 Artifact isolation | Not started | — | Per-child artifact root keyed by child session id under the parent's session directory; the runtime creates it and passes it as the child's session directory. Two tests of opposite polarity, per the spec's Risks: a child cannot write an artifact outside its root, **and** a workspace edit the ceiling permits still succeeds — the second is what keeps the exit criterion from being satisfied by a child that can do nothing. Worktree isolation is gated on the open question below and does not land unmeasured |
| 5.5 Agent definitions and discovery | Not started | — | Real implementation behind 5.2's resolver interface: markdown + frontmatter (`name`, `description`, `tools`, `model`), user scope (`~/.apex-code/agent/agents/`) loaded by default, project scope (`.apex-code/agents/`) opt-in and gated through `trust-manager.ts` rather than a bespoke prompt. Tests: a project-scope definition is not loaded without trust; a malformed or incomplete definition is skipped rather than partially applied; a definition naming a nonexistent tool is refused with the name, not silently narrowed |
| 5.6 Background execution and result retrieval | Not started | — | `delegate` can return before its child completes, yielding a handle; the parent retrieves the result later. Tests cover retrieval while the child is running and after it completes, plus retrieval of an unknown handle. Any retrieval surface added here defers its schema, so `ENFORCED_PRODUCTION_PREFIX_BUDGET` does not move |
| 5.7 Ceiling invariant and phase verification | Not started | — | `contracts.md` **invariant 4** as a registry-enumerating test in `test/permissions/contract.test.ts` — the registry, not a hand-maintained scenario list, per invariant 2's precedent. The `bash`-holding-parent rule-level test the spec's Risks insist on (without it the ceiling check can never fail for a realistic parent). `delegate` rule-grammar compatibility: an `explore:*` rule written before this phase resolves identically. Sandbox: a child still cannot reach the network from inside the sandbox, reusing the shape of Phase 4's real-bwrap tests. Static prefix unchanged at 2,150/2,300. Full-suite run with every failure traced individually against the pre-phase baseline, as in task 4.7 |

## Order changes

None yet, but one **correction to the spec's problem statement**, found while
decomposing it. The spec lists two reproductions of the ceiling bypass; only the second
is reachable through Apex Code's own gate.

Reproduction 1 (parent under `--permission-mode plan` delegates, child resolves its own
`default` mode) describes the rejected subprocess design, not a state this phase can
reach: `delegate` carries `{delegate}`, which is in `PLAN_MODE_DENIED_CAPABILITIES`
(`modes.ts:25`), so plan mode denies the delegation outright and no child exists to
test. Phase 4 already landed that end-to-end gate test. The live equivalent is **mode
inheritance** — a child's mode is the parent's derived mode, never a freshly resolved
one — and that is what task 5.7 tests, using a non-`plan` restrictive mode where a
child actually gets created.

Reproduction 2 (a `session`-source rule in the parent, in memory only, must be in force
in the child) is reachable, is the sharper test, and is the one task 5.1 is written
against.

## Task 5.1 — ceiling and derived store

### Red

1. Ceiling unit tests against a function that does not exist yet: subset admitted,
   non-subset refused with the offending capability named, `exec` in the parent
   expanding to the full set, `exec` requested by a child under a parent without it
   refused. Assert the refusal carries the capability name — a boolean is not enough to
   write a useful denial message from later.
2. Derived-store tests through `evaluateToolCall`, both directions: a `session`-source
   deny created in the parent blocks the same call in the child; an approval persisted
   inside the child is absent from the parent's snapshot after the child completes.
   Drive these through the gate rather than the store's own surface, so what is proven
   is a decision, not a data structure.
3. A negative test that the derived store cannot be constructed to write a file-backed
   source (`local`/`project`/`user`) — the overlay is runtime-only by construction, not
   by convention.

### Green

- Implement `core/delegation/ceiling.ts` as a pure function over capability sets, with
  no knowledge of tools, sessions, or agent definitions. It takes sets and returns a set
  or a refusal; everything about *how* the parent's set was computed stays out of it.
- Implement the derived store in `core/permissions/store.ts` alongside the existing
  backends, satisfying the same `PermissionRuleStore` interface so the gate consumes it
  without knowing it is derived. The gate must not learn what a child is.
- Compute the parent's effective set from `getActiveToolNames()` and the contract
  lookup, expanding `exec` at that boundary — the same registry the permission gate and
  the deferred-schema loader read, so a fourth consumer does not derive a fifth answer
  (ADR 0010's rule, and the drift task 4.1's hardening pass already fixed once).

### Refactor

Keep the ceiling function free of session and tool types, and keep the derived store
behind the existing `PermissionRuleStore` interface. If either one needs to import from
`core/delegation/runtime.ts`, the dependency is backwards: the runtime composes these
two, they do not know about it.

## Shared implementation rules

- Write the failing test before each implementation slice and run the narrowest test.
- Tests that drive sessions or write state use `mkdtemp`/`chdir` and clean up; no test
  writes to the repository's own `.apex-code` state. This matters more here than in
  Phase 4 — a child session writes its own artifact tree, so a leak is a directory, not
  a file.
- A child's authority is never reconstructed. Any code path that reads permission state
  from disk, argv, or environment to build a child violates ADR 0008 and is the thing
  review is looking for.
- The child passes through the **same** `evaluateToolCall` as the parent. No second
  decision function, no delegation-specific branch inside the gate.
- Every refusal names its cause — the offending capability, the depth bound, the unknown
  agent type. A silently narrowed child produces work that looks complete and is not.
- Session entry types and header fields added by this phase are recorded in
  `contracts.md` §3's inventory table **in the same commit that adds them**, not
  retroactively.

## Open questions to close by measurement

| Question | Closed by | Why it cannot be settled now |
| --- | --- | --- |
| Is worktree isolation the default for `fs.write`-capable children, or opt-in? | Task 5.4 | Costs a `git worktree` checkout per delegation. Nobody has measured that cost against a realistic repository, and defaulting it on an unmeasured guess is how delegation becomes too slow to use |
| What is the hard cap above the configurable `delegationDepth` default of 2? | Task 5.3 | The default of 2 is defensible from the comparative review (no surveyed harness demonstrated a use for a third level). The *cap* is a different number and should follow from observed token cost per level, which task 5.3 can measure directly |

Both are carried here rather than guessed in the spec, for the same reason Phase 4
carried its budget and its `grep`/`find`/`ls` deferral choice into task 4.1: a number
fixed by measurement is a phase fact, and a number fixed by argument is a number the
next phase relitigates.
