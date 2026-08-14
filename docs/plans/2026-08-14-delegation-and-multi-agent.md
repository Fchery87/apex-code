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
| 5.1 Capability ceiling and derived permission store | Done | — | `core/delegation/ceiling.ts`: pure `computeCapabilityCeiling(parent, requested)` with `exec` expanded per `contracts.md` §1.1, returning either `{allowed: true, capabilities: requested}` (the exact request, never the wider expanded-parent set) or `{allowed: false, deniedCapability}` naming the first uncovered capability; 9 unit tests covering subset, non-subset, `exec`-expansion, `exec` itself gated by the parent holding it, and the empty-parent edge (`test/delegation/ceiling.test.ts`). `core/permissions/store.ts`: `DerivedPermissionRuleStore` — `snapshot()` reads the parent fresh on every call (never cached) and merges in a child-local overlay; `apply()` writes only to the overlay and only for `command`/`session`, rejecting `local`/`project`/`user` outright rather than silently redirecting. 6 tests through `evaluateToolCall` (the real gate decision function, not the store surface directly): a `session`-source rule already in the parent blocks/allows the child identically (closing the spec's problem item 2 bypass); a rule persisted inside the child via `persist: true` is visible in the child's own snapshot but absent from an independently-taken parent snapshot afterward (closing item 7 — a child's approval cannot widen its parent); a file-backed `apply()` destination throws and leaves the parent's real file untouched; the parent's runtime-only `cliArg`-source rules (never written to disk) are inherited too, not only `session` (`test/permissions/derived-store.test.ts`). Full `test/permissions/` + `test/delegation/` suites: 189/189 passing. Typecheck clean (`tsgo -p tsconfig.build.json --noEmit`) |
| 5.2 Delegation runtime and `delegate` execution | Done | — | `core/delegation/runtime.ts`: `runDelegation(options, agentType, task)` resolves the agent definition, unions the capabilities of every tool it names, runs that through the 5.1 ceiling against the parent's own capability set, and only then calls the injected `buildChildSession`; throws for an unresolvable agent type, an unknown requested tool, or a ceiling refusal (naming the offending capability) — the codebase's established convention for model-readable failures (`tool_schema`'s unknown-tool case, `web_search`'s unconfigured-backend case), not a fatal turn failure. 7 unit tests against fixture collaborators (`test/delegation/runtime.test.ts`), including the plan's own required scenario: a definition naming `bash` under a parent holding only `{fs.read, delegate}` is refused before `buildChildSession` is ever called — no code path produces a child holding `bash`. `delegate.ts` takes `DelegationRuntimeOptions` as a required argument (mirroring `todo_write`'s store / `tool_schema`'s resolver injection exactly); `execute` now returns real output instead of unconditionally throwing. `index.ts` gained a `noopDelegationRuntime` default (mirrors `noopTodoWriteStore`) so `delegate` stays registered and callable everywhere but inert until a caller wires a real runtime. Real production wiring lives in `sdk.ts`'s new `createAgentSession({ delegation: { resolveAgent } })` option: it injects a real `DelegationRuntimeOptions` via `customTools` (overriding the built-in stub through the existing name-keyed registry merge — no new `AgentSession` plumbing, no import cycle with `agent-session.ts`); `getParentCapabilities` reads the parent's live active tools through a forward-ref (mirrors the existing `extensionRunnerRef` pattern); `getToolCapabilities` checks the parent's own registry first and falls back to the canonical built-in registry, so a tool the parent excluded via `tools`/`excludeTools` is still recognized as "a real tool needing capability X" rather than "unknown tool" — a distinction an earlier version of this task got wrong and the end-to-end test caught; `buildChildSession` recursively calls `createAgentSession` with a `DerivedPermissionRuleStore` (5.1) wrapping the parent's live store, the parent's own `getMode` passed through unchanged (mode inheritance), and deliberately **no responder** (ADR 0008: a child's `ask` fails closed rather than prompting the human for a call they did not make). 2 real end-to-end tests through `createAgentSession` itself, no mocking of the delegation machinery (`test/delegation/end-to-end.test.ts`): a parent holding `{fs.read, delegate}` delegates to a `scout` agent (`tools: ["read"]`) and receives the child's actual generated output text back as the tool result; the same parent delegating to a `worker` agent (`tools: ["read", "bash"]`) is refused with a message naming `exec`, child never constructed. Full `test/delegation/`, `test/permissions/`, `test/tools/`, and every `sdk.ts`-consuming test file (8 files) pass: 282+ tests total. Typecheck clean (`tsgo -p tsconfig.build.json --noEmit`) |
| 5.3 Recursion depth guard | Done | — | `delegationDepth?: number` added to `SessionHeader`/`NewSessionOptions` (absent means 0; additive-optional, no version bump, per `contracts.md` §3), threaded through `newSession()`'s header construction; `SessionManager.getDelegationDepth()` reads it back (`?? 0`). 4 tests (`test/session-manager/delegation-depth.test.ts`), including a session created with no options at all -- exactly what every pre-5.3 session looks like -- reading back as depth 0. `SettingsManager.getDelegationMaxDepth()`: default 2, clamped to a hard cap (`DELEGATION_MAX_DEPTH_HARD_CAP = 5` -- a conservative placeholder, not a measured number; the plan's own open question about the real cap is still open and carried forward, since no real per-level token-cost measurement exists yet). Non-positive/malformed configured values fall back to the default rather than blocking startup (this is a safety ceiling, not a value worth failing a session over). 5 tests in `test/settings-manager.test.ts`. `runDelegation()` (runtime.ts) checks `getDelegationDepth() >= maxDelegationDepth` right after agent-type resolution and before the capability check -- refused before `buildChildSession` is ever called, so no child session (and, once 5.4 lands, no artifact directory) is created past the bound; the refusal names the configured bound. `BuildChildSessionRequest` gained `depth: number` (parent + 1), assigned by the runtime, not the tool -- 4 new unit tests in `test/delegation/runtime.test.ts` (depth passed correctly, refused at the bound naming it, refused past the bound too, still admitted one level below it). `sdk.ts` wires `getDelegationDepth: () => sessionManager.getDelegationDepth()` and `maxDelegationDepth: settingsManager.getDelegationMaxDepth()` into the real runtime, and records the child's depth via `SessionManager.inMemory(cwd, { parentSession, delegationDepth: depth })`; also fixed a real gap task 5.2 left: the recursive `createAgentSession` call inside `buildChildSession` did not forward `options.delegation`, so a child could never delegate again regardless of depth -- silently capping recursion at one level. A real 3-level end-to-end test (`test/delegation/end-to-end.test.ts`) proves the wiring: root (depth 0) delegates to a self-delegating agent, admitted to depth 1, admitted again to depth 2, and depth 2's own delegate attempt is refused before a fourth session is built -- asserted via the faux provider's real (non-cycling, `shift()`-based) call counter landing at exactly 6, not 7. Verified this test is not vacuous: temporarily removed the depth check, confirmed the call count went to 7 and the assertion failed, then restored it. All affected suites green, typecheck clean |
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
