# Spec: Delegation — a child agent whose authority is derived from its parent's, never reconstructed

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Created | `2026-08-14` |
| Last updated | `2026-08-14` (ADR 0008 accepted) |
| Roadmap phase | `5 — Delegation & multi-agent` |
| Tracking issue/PR | none |
| Compatibility posture | **Preserves compatibility, with one clean break inside a surface that has never executed.** See below. |

**Compatibility posture.** `delegate`'s parameter schema changes — it gains fields for
background execution and result retrieval. That is a clean break, and it is free: the
tool has thrown unconditionally since it landed (`delegate.ts:43`), so no session, no
settings file, and no user workflow depends on its current shape. Its schema is also
deferred, so it is not even in the static prefix a cached prompt was built against.

Everything a user could have written down is preserved. `delegate` keeps its name, its
`{delegate}` capability set, its `ask` default, and — the part that matters for
`settings.json` — its `ruleForCall` agent-type glob grammar, so a rule like
`explore:*` written before this phase resolves identically after it. `SessionHeader`
gains one optional field; older readers ignore it and older sessions lack it, which is
exactly the additive-and-discriminated rule `docs/architecture/contracts.md` §3 puts in
force until Phase 6 settles the entry schema. No CLI flag changes meaning.

## Executive summary

Phase 5 turns `delegate` from a declared contract into an executing one. The design
question that decides whether the phase's exit criterion is reachable is not how to
spawn a child — it is where the child's authority comes from. This spec's position is
that a capability ceiling is only enforceable if the child's permission decisions route
through a store, mode, and gate **derived from the parent's live in-memory state**; any
design that reconstructs authority from disk and argv — which is what the only working
subagent implementation in this repository does — is a ceiling bypass by construction,
because four of the eight permission-rule sources never touch disk. On top of that
derivation this phase adds a recursion depth bound recorded in the session header, a
per-child artifact directory, and background execution with retrievable results.

## Context and motivation

- `docs/roadmap.md`, Phase 5 — the phase this serves, including the scope sentence this
  spec corrects (see The problem, item 1) and the three-clause exit criterion
  Verification maps onto one-for-one.
- `docs/architecture/contracts.md` §1.1 — the **capability ceiling** and the **`exec`
  escalation rule**, both written ahead of this phase precisely so it would not
  rediscover them. Its phasing table already assigns Phase 5 exactly one row:
  *"`capabilities` consumed by ceiling enforcement; invariant 4."* Invariant 4 is the
  registry-level test this phase makes live.
- `docs/architecture/contracts.md` §3 (Session entry schema — **open**) — Phase 5 is one
  of its four writers, listed as contributing "delegation and recursion depth." Its
  standing rule for pre-Phase-6 additions (additive, discriminated, recorded in the
  inventory table as it lands) governs everything this phase writes.
- `docs/specs/2026-08-11-permission-rule-model.md` and ADR
  `0004-permission-rule-model.md` — the eight-source model whose runtime-only half is
  the load-bearing fact of The problem, item 2.
- `docs/specs/2026-08-12-os-sandbox.md` and ADR `0005-sandbox-boundary-guarantees.md` —
  the whole-CLI-launch boundary a child inherits either way, and therefore *not* what
  distinguishes the two candidate designs.
- `docs/specs/2026-08-13-tool-surface.md` §Non-goals — *"Delegation execution is Phase
  5's… This phase ships the entry point's contract, capability declaration, and rule
  grammar so Phase 5 has a declared surface to enforce a ceiling against."* That surface
  is what this spec consumes.
- `docs/research/2026-08-08-harness-comparative-review.md`, Finding 5 — Prime's
  recursion-depth field and per-subagent artifact directories, observed. Per ADR 0002
  this is the only channel by which those ideas enter, and they enter as described
  behavior, not code.
- ADR `0008-delegation-authority.md` — this phase's one irreversible decision, now
  settled: an in-process derived child, not a subprocess with serialized authority.
  Its reserved title ("`pi-subagents` dependency vs. owning it") is corrected in the
  ADR itself, for the same reason as item 1 below.

## Current state

**`delegate` exists and does nothing.** It declares `{delegate}`, `ask`, an agent-type
`minimatch` grammar whose `ruleForCall` returns the exact `agentType` of the call,
`deferSchema: true`, and `evidence.emits: {workflow}`. `execute` throws
(`core/tools/delegate.ts:43-47`). `delegate` is in `PLAN_MODE_DENIED_CAPABILITIES`
(`core/permissions/modes.ts:25`), so plan mode denies it outright, and Phase 4 landed an
end-to-end gate test proving that against the real registered tool.

**There is no delegation machinery in `src/`.** The only working implementation anywhere
in the repository is the upstream-inherited example extension
`packages/coding-agent/examples/extensions/subagent/` (1,009 + 126 lines). It spawns a
fresh CLI process per child:

```
--mode json -p --no-session [--model M] [--tools a,b,c] --append-system-prompt <tmp> "Task: …"
```

(`index.ts:288-331`). Agent definitions are markdown files with YAML frontmatter
(`name`, `description`, `tools`, `model`) discovered from `~/.apex-code/agent/agents/`
and the nearest `.apex-code/agents/` (`agents.ts:104-124`), with project scope opt-in
and interactively confirmed. The child's `cwd` is a **model-supplied tool parameter**
(`index.ts:428`). Nothing about permission mode, permission rules, recursion depth, or
artifact location crosses into the child.

**Permission authority is split across eight sources, four of which never touch disk.**
`policy`, `local`, `project`, and `user` are file-backed; `flag`, `cliArg`, `command`,
and `session` are runtime-only, held in memory for the life of the process
(`core/permissions/store.ts:8-35`). The `session` source is specifically where a rule
lands when a human answers an approval prompt with "always" — `evaluateToolCall` writes
it there (`core/permissions/gate.ts:83-89`). The mode is likewise resolved at runtime
from a source-precedence walk in which `flag` outranks every persisted value
(`core/permissions/startup.ts:51-64`).

**The gate is already injectable, and a child session is already constructible.** The
gate is assembled from `{getContract, store, getMode, responder}`
(`core/permissions/gate.ts:21-30`) and accepted at session construction
(`AgentSessionConfig.permissionGate`, `core/agent-session.ts:243`). `createAgentSession`
accepts `permissionGate`, `tools`, `excludeTools`, `sessionManager`, `settingsManager`,
and `resourceLoader` (`core/sdk.ts:38-87`). Building an in-process child from public
seams requires no new plumbing in `agent-core`.

**The session format already links parents to children.** `SessionHeader` carries
`parentSession?: string` (`core/session-manager.ts:33-40`). It carries no depth.

**A gate with no responder fails closed.** An `ask` resolution in a session without a
responder returns `block: true` (`core/permissions/gate.ts:69-74`). This is deliberate
(ADR 0004) and it is the behavior a headless child inherits.

**The sandbox is inherited by either design.** ADR 0005's model launches the entire CLI
inside the sandbox, so a subprocess spawned from within it is itself within it, and an
in-process child trivially is. The sandbox is therefore not the axis on which the two
candidate designs differ, and this phase adds no sandbox mechanism.

**`pi-subagents` does not exist.** Upstream Pi at the fork point (`v0.84.0`) is ten
packages and none of them is a subagents package (`docs/upstream-log.md`). Nothing named
`pi-subagents` is a dependency of this repository, vendored or declared. The two nearest
real things are the bundled example extension above and `HazAT/pi-interactive-subagents`,
a third-party git-sourced extension that appears only inside a test fixture
(`test/interactive-mode-status.test.ts:649`).

Everything above except the example extension and the session format is Apex Code's own
code. The example extension is upstream's, unmodified (ADR 0003 merge-cost note: this
phase does not touch it, so it adds no conflict surface).

## The problem

**1. The roadmap's Phase 5 scope names a dependency that does not exist and cites ADR
numbers that are not this repository's.** The scope reads: *"Build on `pi-subagents`'
decomposition rather than from zero — its `capability-ceiling`, `preflight`, and
`control-channel` are the right primitives, and existing ADRs 0009 and 0024 already
govern that dependency."* In this repository ADR 0009 is reserved for telemetry, there
is no ADR 0024, and the ADR reserved for delegation authority is 0008. `pi-subagents` is
absent from the dependency graph and from the upstream package inventory. This is the
same class of defect Phase 4 found in its own exit criterion — a sentence that reads
plausibly and is unreachable as written — and it is corrected the same way: restated
against what exists, with the correction dated in the roadmap rather than silently
rewritten.

**2. The only working delegation in the repository is a ceiling bypass by
construction.** The subprocess model reconstructs the child's authority by re-reading
settings from disk and accepting a `--tools` list on argv. The four runtime-only rule
sources cannot cross that boundary, and neither can the mode. Two concrete
reproductions:

- Run the parent under `--permission-mode plan`. Delegate. The child process resolves
  its own mode from its own settings — `default`, absent a persisted value — and writes
  files the parent was categorically denied.
- Have a human answer an approval prompt in the parent such that a `session`-source rule
  is written (`gate.ts:83-89`). That rule exists only in the parent's memory. Delegate.
  The child has never heard of it.

This is not a defect in the example extension. It is what "spawn a fresh CLI" means, and
any subprocess design inherits the obligation to serialize every one of those sources
correctly, forever, including the ones added after this phase.

**3. `--tools` is a tool allowlist, not a capability ceiling, and the difference is
`exec`.** `contracts.md` §1.1 states the escalation rule: a tool with `exec` reaches
every other capability through the subprocess it spawns, so enforcement must treat
`exec` as implying the full set. A list like `read,grep,bash` reads as restrictive and
is not. A ceiling expressed as a tool list is only as strong as a reviewer noticing one
entry, which is precisely the failure mode contracts.md predicted: *"a ceiling bypass
that looks correct in the type system."*

**4. Nothing bounds recursion.** An agent whose tool list includes the delegating tool
delegates again. There is no depth in the header, nothing to check it against, and each
level multiplies both token cost and the distance between the human and the work.

**5. "Subagent artifacts never write outside their own directory" is ambiguous, and the
literal reading makes the phase useless.** Read literally it forbids a child from
editing the repository — which eliminates the only kind of child that does
implementation work. The criterion is about the child's *artifacts* (its session log,
its returned output, its scratch space), not about workspace edits, which are governed
by the ceiling and the existing path-permission grammar. Left unstated, the criterion is
either satisfied vacuously or satisfied by shipping something nobody can use.

**6. Nobody answers a child's `ask`.** A child with no responder fails closed on every
`ask`-default tool (`gate.ts:69-74`), so a child inheriting `bash` will be denied on its
first call and look broken. The alternative — forwarding the parent's responder —
prompts a human to approve a call they did not make, from an agent whose context they
cannot see. Both options have real costs and neither is currently chosen.

**7. An approving child can widen its parent.** If a child shares the parent's store
instance, an `answer.persist` inside the child writes an `allow` rule at `session` source
*into the parent's store* (`gate.ts:83-89`). The child raises the parent's authority.
Naive sharing does not merely fail to enforce the ceiling — it inverts it.

## Goals

- [ ] `delegate` executes: a real child agent runs a task and its result returns to the
      parent, proven end-to-end through `createAgentSession`, not at the primitive level.
- [ ] A child's effective capability set is a subset of its parent's, with `exec`
      expanded per `contracts.md` §1.1, enforced at delegation time — and asserted by
      contracts.md **invariant 4** as a registry-level test that enumerates the registry
      rather than a hand-maintained scenario list.
- [ ] Both reproductions in The problem item 2 are closed by test: a `plan`-mode parent's
      child cannot write, and a `session`-source deny in the parent is in force in the
      child.
- [ ] A child's approval never widens its parent — a test asserts a rule persisted inside
      a child is absent from the parent's store after the child completes.
- [ ] Recursion terminates: depth is recorded in the session header, checked at
      delegation time, and a test drives delegation past the bound and gets an explicit
      denial naming the bound — not a stack of sessions.
- [ ] Every child writes its session log and outputs under a per-child artifact
      directory, with two tests: a child cannot write an artifact outside it, and a
      workspace edit the ceiling permits still succeeds.
- [ ] `delegate` can return before its child finishes and the parent can retrieve the
      result later; tests cover retrieval while running and after completion.
- [ ] The Phase 4 entry point is preserved: `delegate` keeps its name, capability set,
      and agent-type `ruleForCall` grammar, and a rule written before this phase
      resolves identically (test).
- [ ] Every session entry type or header field this phase adds is recorded in
      `contracts.md` §3's "Entry types added before Phase 6" table as it lands.

## Non-goals

- [ ] **Inter-agent messaging.** The roadmap admits it "only if a concrete use case
      demands it," and none does. Parent→child is the task; child→parent is the result.
      A general channel is a protocol with its own delivery, ordering, and authority
      questions, and nothing in the exit criterion needs one.
- [ ] **An agent-definition ecosystem.** Definitions stay markdown with frontmatter,
      discovered from the two scopes the example already uses, project scope gated on
      `trust-manager.ts`. No registry, no versioning, no remote fetch — a remotely
      fetched agent definition is a supply-chain surface that needs its own trust story,
      and inventing one here would be the largest section of this spec for the least
      connected reason.
- [ ] **Multi-client or daemon-mediated delegation.** "Background" here means *in this
      process, retrievable within this session*. Surviving a restart is Phase 6's command
      journal and snapshot cache; solving durability twice guarantees the two solutions
      disagree.
- [ ] **Per-agent model routing.** An agent definition may name a model, and that name is
      honored. Measured routing, fallback chains, and roles are Phase 1's and are not
      re-litigated by a delegation parameter.
- [ ] **Any new sandbox mechanism.** ADR 0005's boundary is inherited by a child under
      either candidate design. This phase must *test* that a child does not widen it and
      builds nothing new to do so.
- [ ] **Settling whether delegation subtrees are entries in the parent session or
      separate linked sessions.** `contracts.md` §3 assigns that to Phase 6 and names it
      as an open question by name. Phase 5 uses the shape the format already expresses —
      separate sessions linked by `parentSession` — and records it as an inventory row,
      not as a settled format decision.

## Proposed solution

The whole design follows from one rule: **derive, never reconstruct.** Every element of
a child's authority is an object the parent hands it, not a value the child looks up.

### The delegation authority decision — settled by ADR 0008

`docs/adr/0008-delegation-authority.md` decides this: **an in-process derived child**,
not a subprocess with serialized authority. Build a child `AgentSession` from the
parent's live services, with a gate assembled from a derived store, a derived mode, and
a ceiling-restricted tool set. The ceiling is enforced by construction, because the
child's gate is an object the parent constructed. Context isolation — the actual
product benefit of delegation — is a property of the child's *message list*, which a
child `AgentSession` has independently of process boundaries. Cost, accepted: a runaway
or crashing child lives in the parent's process, bounded by the depth guard and the
existing abort path (carried in Risks below).

The rejected alternative — spawn a CLI, as the example extension does, but serialize
the mode, all eight rule sources, the depth, and the artifact root correctly through
argv and environment — is rejected because fidelity to that serialization becomes a
permanent obligation: every future addition to permission state is a new thing that can
be forgotten, and forgetting it is silent and looks like it works. The full reasoning,
including the rejected "share the store" and "forward the responder" variants, is in
the ADR; it is not repeated here.

### Components

| Component | Change | File(s) |
| --- | --- | --- |
| `delegate` | `execute` runs a child through the delegation runtime; schema gains background/retrieval fields | `core/tools/delegate.ts` |
| Delegation runtime | Builds a child session from parent services + ceiling; owns depth, artifact root, lifecycle | `core/delegation/runtime.ts` (new) |
| Capability ceiling | Pure function: parent set + requested set → child set or a named rejection, `exec` expanded | `core/delegation/ceiling.ts` (new) |
| Derived permission store | Read-through view of the parent's snapshot; child writes land in a child-local overlay | `core/permissions/store.ts` (extend) |
| Depth guard | Optional `delegationDepth` on `SessionHeader`; child = parent + 1; refused above the bound | `core/session-manager.ts` |
| Artifact root | Per-child directory; the child's session file and outputs are written there | `core/delegation/artifacts.ts` (new), `core/session-manager.ts` |
| Agent definitions | Frontmatter discovery, user scope by default, project scope gated on trust | `core/delegation/agents.ts` (new), `core/trust-manager.ts` |
| Result retrieval | Handle returned on a background delegation; retrieval of a running or completed child | `core/tools/delegate.ts` |
| Invariant 4 | Registry-level subset test, per `contracts.md` §1.1 | `test/permissions/contract.test.ts` |

### Ceiling mechanics

1. **Parent's effective set** = the union of the capability sets of the parent's *active*
   tools. If that union contains `exec`, it expands to the full `Capability` set, per
   `contracts.md` §1.1.
2. **Requested set** = the union over the tools named by the agent definition.
3. **Child's set** = requested ∩ parent, after expansion. If the requested set is not a
   subset, the delegation is **refused with the offending capability named** rather than
   silently narrowed. A silently narrowed child produces work that looks complete and
   is not, which is worse than a refusal the model can read and route around.
4. The child's **tool list is derived from its capability set**, not taken from the agent
   definition directly. This is what closes The problem item 3: a definition cannot
   smuggle `exec` past the ceiling by naming `bash` in a list.
5. `delegate` is in the child's set only if the parent had it **and** depth is below the
   bound. At the bound the tool remains visible and the gate denies it with a reason
   naming the bound — an unexplained absence teaches the model nothing.

### Who answers a child's `ask`

**Settled here: the child does not receive the parent's responder.** A child runs against
a derived store in which the parent's explicit rules apply, and an unmatched `ask` fails
closed. Delegation is therefore useful exactly to the extent the parent has already
authorized the work, which is the honest reading of "cannot exceed its parent's
authority." A parent that wants a child to do something not yet authorized authorizes it
first — an explicit rule, or a broader mode, which the ceiling then bounds.

Forwarding the responder is rejected on consent grounds, not UX grounds: it asks a human
to approve a call they did not make, described by a rule grammar, without the child's
context in front of them. That is a worse decision surface than the parent's own prompt,
and approving it grants authority inside a context the approver cannot see.

The cost is real and is carried in Risks: this makes an under-authorized parent's child
stall on its first tool call.

### Store derivation

The child's store `snapshot()` returns the parent's snapshot merged with a child-local
overlay. `apply()` writes **only** to the overlay, and only for the runtime sources
(`session`, `command`); the overlay is discarded when the child completes. There is no
code path from a child's approval to the parent's store, which closes The problem item 7
structurally rather than by discipline.

### Depth

`SessionHeader` gains `delegationDepth?: number`; absent means `0`. Additive and
optional, so no version bump — the rule `contracts.md` §3 puts in force until Phase 6.
The roadmap names this field `rlmDepth` after Prime's; it is renamed here because it is
our format and the abbreviation carries no meaning in it. The correspondence is recorded
so the roadmap line stays traceable.

The check lives in the delegation runtime, not in `delegate`'s `execute`, so it applies
to any future delegation entry point rather than to one tool.

**Default bound: 2** — parent → child → grandchild. Settings-configurable with a hard
cap. Each level multiplies token cost and moves the human one more step from the work,
and no harness in the comparative review demonstrated a use for a third.

### Artifacts

The artifact root is a per-child directory under the parent's session directory, keyed by
the child's session id. It holds the child's session JSONL and anything the child
produces *as output*. The runtime creates it and passes it as the child's session
directory.

**Workspace edits are not artifacts.** A child permitted `fs.write` by the ceiling edits
the workspace through the same path-permission grammar every other write goes through
(`core/tools/path-permission.ts`). This is The problem item 5 resolved into two separate
tests rather than one ambiguous sentence.

Worktree isolation — declared as a property of the delegation entry point back in the
Phase 4 spec — is the stronger option where a parent wants a child's edits contained:
the child's `cwd` becomes a git worktree and its edits land on a branch. Whether that is
the default for `fs.write`-capable children is carried to the plan as an open question,
because it costs a checkout per delegation and that cost has not been measured.

### Seam invariants

`beforeToolCall`: a child's tool calls pass through the **same** `evaluateToolCall`, with
a different store and mode. No second decision function and no delegation-specific
bypass — one code path is what makes the ceiling a property rather than a convention, and
it is what keeps the universal-gate invariant (invariant 2, "no exceptions list") true
for child sessions without extending it.

Evidence capture: `delegate` keeps emitting its `workflow` record. The child's own tool
calls emit their own evidence into the child's session, which Phase 7's ledger reaches
through the `parentSession` link — so delegation does not create a category of tool call
whose evidence is captured by its caller rather than at the source (ADR 0007's whole
point).

`transformContext`: the child runs its own context pipeline. No compaction or eviction
state crosses the boundary in either direction.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `delegate.execute`'s unconditional throw and its "not implemented until Phase 5" message | code | Removed — replaced by real execution through the delegation runtime |
| `delegate.ts`'s doc comment citing "`pi-subagents` primitives not yet vendored" | doc | Superseded — the dependency does not exist (Current state); restated against the runtime this phase builds |
| Roadmap Phase 5's `pi-subagents` / "ADRs 0009 and 0024" scope sentence | doc | Superseded — corrected in place with a dated amendment, per the roadmap's own convention of appending corrections rather than rewriting history |
| ADR 0008's reserved title, "Delegation authority: `pi-subagents` dependency vs. owning it" | doc | Superseded — retitled to the decision that is actually open: in-process derived child vs. subprocess with serialized authority |
| `contracts.md` §1 phasing row "5 — `capabilities` consumed by ceiling enforcement; invariant 4" | doc | **Satisfied, not deleted** — the row stays; the invariant becomes a live test |
| `examples/extensions/subagent/` | code | **Retained unchanged.** Upstream example code on no Apex Code code path; deleting it raises merge cost for no gain (ADR 0003). Cited here as the current state, not adopted as the implementation. |

Nothing in the session format, the settings schema, or the CLI surface is removed. The
one behavioral removal — `delegate`'s throw — is the removal the phase exists to perform.

## Risks

**A ceiling that is correct and useless.** If `ask` fails closed and parents rarely
pre-authorize, every child stalls on its first `bash` call and delegation reads as
broken. This is the direct cost of the responder decision above and it is the most likely
way this phase ships something nobody uses. Signal: a "denied on first tool call" count
per delegation across the corpus, and it is the first thing to check against any report
that delegation "doesn't work."

**In-process children and the parent's event loop.** A child that hangs, floods stdout,
or aborts badly is inside the parent's process. Signal: the existing abort-path tests
extended to cover a running child, plus a wall-clock bound on child execution.

**The `exec` escalation rule swallowing the ceiling.** Nearly every useful parent holds
`bash`, so nearly every parent's effective set is "everything," and the subset check
passes trivially. For such a parent the ceiling's real teeth are the *rules* and the
sandbox, not the capability set. Signal — and this is the one to insist on in review: a
test that asserts the rule-level restriction on a `bash`-holding parent, not only the
capability-level one. Without it the phase ships a check that can never fail.

**Depth bound wrong in either direction.** Two is a judgment call. Signal: the denial is
explicit and names the bound, so hitting it appears in output rather than as a child that
quietly did less.

**Artifact-versus-workspace confusion resurfacing.** The distinction is a sentence, and
sentences erode. Signal: it is carried as two tests with opposite polarity — no write
outside the artifact root, *and* a permitted workspace edit still succeeds — so weakening
either one is visible in a diff.

**Session entries written before `contracts.md` §3 settles.** Phase 6 inherits whatever
this phase writes, and Phase 9 turns it into a compatibility promise. Mitigation is
already in force rather than invented here: additive, discriminated, and recorded in the
inventory table as it lands.

## Verification

- **End-to-end** — `createAgentSession` test: parent delegates, a real child session
  runs the task, the result returns to the parent.
- **Ceiling** — unit tests over the pure function including `exec` expansion and the
  named-capability refusal; plus `contracts.md` **invariant 4** as a registry-enumerating
  test in `test/permissions/contract.test.ts`.
- **Bypass closed** — one test per reproduction in The problem item 2: a `plan`-mode
  parent's child cannot write; a `session`-source deny in the parent is in force in the
  child.
- **Non-widening** — a rule persisted inside a child is absent from the parent's store
  after the child completes.
- **Depth** — delegation at the bound is refused with a reason naming it, and no child
  session or artifact directory is created past it.
- **Artifacts** — negative (no write outside the root) and positive (a ceiling-permitted
  workspace edit succeeds).
- **Background** — retrieval while the child is running and after it completes.
- **Rule-grammar compatibility** — an `explore:*` `delegate` rule written before this
  phase resolves identically after it.
- **Sandbox** — a child still cannot reach the network from inside the sandbox, reusing
  the shape of Phase 4's real-bwrap tests rather than a mock.
- **Phase gate** — the roadmap's three exit clauses map one-to-one onto the ceiling,
  depth, and artifact tests above; no clause is satisfied by inspection.
- **Static prefix** — `ENFORCED_PRODUCTION_PREFIX_BUDGET` (2,300, enforced at 2,150)
  should not move: `delegate` already defers and any retrieval surface should too. A test
  asserting it is unchanged is cheap and catches an accidentally always-loaded new tool.
- The existing replay-corpus gates stay green and unmodified.

## Rollout

Needs `docs/plans/2026-08-14-delegation-and-multi-agent.md`. The work is several
independent slices — ceiling, store derivation, depth, artifacts, background execution,
agent discovery — behind one blocking decision, and the phase needs its own status
tracking to keep "a child runs" distinct from "a child cannot exceed its parent," which
is the only one of the two the exit criterion counts.

**Done:** ADR `0008-delegation-authority.md`, retitled and written — in-process derived
child versus subprocess with serialized authority. It was irreversible in the sense
that mattered — it determines whether the ceiling is structural or a permanent
serialization obligation, and the shape of every test in Verification follows from it.

**Done:** a dated correction appended to `docs/roadmap.md`'s Phase 5 section, recording
that its scope sentence named a nonexistent package and two ADR numbers from another
repository's sequence, and restating the scope against `contracts.md` §1.1 and the
delegation runtime this spec proposes.

Two items are carried to the plan as open questions rather than settled here, because
both need a measurement that does not exist yet: whether worktree isolation is the
default for `fs.write`-capable children or opt-in, and the settings-configurable ceiling
on `delegationDepth` above the default of 2.
