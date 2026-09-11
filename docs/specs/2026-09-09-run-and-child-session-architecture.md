# Spec: Unified runs and child sessions

**Status:** Active

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Created | `2026-09-09` |
| Roadmap phase | Product architecture follow-up |
| Compatibility posture | Preserve the public `delegate` tool and existing session readers. Replace its internal one-shot execution model with child sessions. Additive protocol changes are preferred. |

## Executive summary

Apex Code has most of the pieces needed for a strong multi-agent coding harness, but
they are not yet one execution model. The production delegation runtime already
enforces capability ceilings, recursion depth, per-child artifact directories, project
trust, background handles, and evidence. The agent loop already owns budgets. The
verification lifecycle already owns configured checks. The sandbox already owns the OS
boundary. Sessions already support resume, fork, compaction, and checkpoints.

The remaining problem is ownership. A delegated child is currently represented as a
promise behind `delegate`, while a background shell has a separate handle registry.
Codex CLI's stronger experience comes from making a thread or run the object that owns
turns, approvals, sandbox policy, child agents, and resumability. Apex Code should take
that architectural lesson without copying Codex's provider assumptions.

This spec makes `Run` the internal execution boundary and makes every delegated child
a linked child session. Existing systems remain the source of truth for their domain.
The run coordinates them. It does not replace them.

## Findings that constrain the design

### Apex Code already owns these capabilities

- `createDelegateToolDefinition()` exposes a `delegate` tool with a canonical tool
  contract in `packages/coding-agent/src/core/tools/delegate.ts`.
- `runDelegation()` derives child authority from the parent's live capabilities in
  `packages/coding-agent/src/core/delegation/runtime.ts`.
- `computeCapabilityCeiling()` prevents a child from acquiring a capability the
  parent does not hold.
- Delegation records depth, creates a per-child artifact directory, and supports
  background execution with retrieval handles.
- `createAgentDefinitionResolver()` loads trusted project and user Markdown agent
  definitions in `packages/coding-agent/src/core/delegation/agents.ts`.
- The agent loop already has typed provider-request, tool-call, and wall-time budgets.
- `VerificationTracker` owns configured verification, evidence, stale-result handling,
  and explicit or post-turn verification.
- The permission gate, sandbox supervisor, evidence capture, session manager, RPC, and
  ACP adapters already own their respective boundaries.

### The current seams are still fragmented

- `ChildSessionHandle` exposes only `run()` and `dispose()`. It cannot receive follow-up
  input, be interrupted, be resumed, or be listed.
- Delegation background state lives in a `WeakMap` of promises. It is not a durable
  child-session registry.
- Background shell uses a separate registry even though it has the same lifecycle
  problem as delegation.
- The `delegate` tool is the public entry point and knows about retrieval handles. The
  session layer does not own the child lifecycle.
- Agent definitions contain tools and prompts, but no typed policy for timeout,
  concurrency, sandbox profile, verification, or model reasoning.
- Apex Code's Windows OS sandbox remains unsupported. This spec does not pretend that
  child-session wiring fixes that.

### Current external comparison

Codex CLI has a coherent thread lifecycle and native child operations for spawning,
messaging, waiting, resuming, interrupting, following up, closing, and listing agents.
It also makes sandbox and approval policy part of the thread configuration.

The poteto-mode pack adds useful engineering rules. The design must encode those rules
as state, boundaries, and validators rather than as another layer of prompt prose.
The relevant rules are bounded work, typed domain state, derived authority, idempotent
retries, context limits, path ownership, and real verification evidence.

## Goals

- [ ] Define one internal `Run` boundary for a root session or a child session.
- [ ] Make a child a linked, addressable session with a lifecycle rather than a promise.
- [ ] Preserve the existing `delegate` tool as a thin launch-or-retrieve adapter.
- [ ] Preserve the canonical tool contract as the only source for capabilities,
      permission grammar, context behavior, and evidence declarations.
- [ ] Derive every child policy from the parent's live effective policy.
- [ ] Keep the parent capability ceiling non-widenable by child approval decisions.
- [ ] Reuse the existing agent loop budget for root and child execution.
- [ ] Reuse the existing `VerificationTracker` and policy executor for child checks.
- [ ] Reuse the existing artifact store and session manager rather than creating new
      output or persistence systems.
- [ ] Add child lifecycle operations to the CLI, RPC, and ACP adapters through one
      internal service.
- [ ] Support explicit concurrency, depth, runtime, model, and verification policies.
- [ ] Prevent overlapping write ownership before parallel child work starts.
- [ ] Return compact summaries while retaining bounded evidence and full artifacts under
      the existing artifact policy.
- [ ] Make interrupted runs resumable without reconstructing authority from disk.

## Non-goals

- [ ] No general autonomous agent-team protocol in this change.
- [ ] No peer mailbox or unrestricted child-to-child chat before the child lifecycle is
      stable.
- [ ] No new scheduler beside the existing agent loop and a single child-run
      coordinator.
- [ ] No new budget implementation. Child budgets use the existing agent-loop budget
      types and counters.
- [ ] No new verification implementation. Child verification uses `VerificationTracker`.
- [ ] No new artifact store. Delegation artifacts use the existing workspace artifact
      ownership and retention rules.
- [ ] No automatic merge, commit, push, or parent-workspace write by the coordinator.
- [ ] No project-local configuration that can widen sandbox, permissions, credentials,
      or writable roots.
- [ ] No automatic modification of `AGENTS.md`, `CONTEXT.md`, or other durable project
      policy. Agents may emit learning proposals as artifacts.
- [ ] No provider-specific runtime abstraction. Provider selection remains in the
      existing model resolver and provider layer.
- [ ] No claim that this spec supplies Windows OS sandbox enforcement.

## Design principles

### One owner per concern

| Concern | Existing owner | Change |
| --- | --- | --- |
| Agent turn execution | Agent loop | Add run identity and child lifecycle callbacks |
| Session persistence | `SessionManager` | Link child headers and persist lifecycle records |
| Tool authority | Tool contracts and permission gate | Derive child policy from the parent |
| OS boundary | Sandbox supervisor and backend | Pass the effective child policy through the existing boundary |
| Verification | `VerificationTracker` and policy executor | Attach child verification to child completion |
| Evidence | Tool and policy evidence emitters | Add run and child IDs to existing records |
| Artifacts | Workspace artifact store | Root child artifacts under the child session |
| Model choice | Existing model resolver | Resolve role defaults without a new routing layer |
| Public integration | CLI, RPC, ACP adapters | Translate protocol calls to the run service |

If a proposed change creates another owner for one of these rows, reject it or amend
the existing owner instead.

### Model the domain as state

The central data shape is a `RunRecord`, not a larger `delegate` parameter object.

```ts
type RunKind = "root" | "child";
type RunStatus = "created" | "running" | "waiting" | "completed" | "failed" | "interrupted" | "closed";

interface RunRecord {
	id: string;
	parentRunId?: string;
	parentSessionId?: string;
	kind: RunKind;
	agentType?: string;
	task: string;
	status: RunStatus;
	depth: number;
	workspaceRoot: string;
	artifactRoot: string;
	policySnapshotId: string;
	budget: AgentRunBudget;
	verificationPolicyIds: string[];
	ownedPaths: string[];
	model?: string;
	createdAt: number;
	updatedAt: number;
}
```

The exact type belongs in the implementation plan. The invariants do not.

### Derive, do not reconstruct

The child policy must be built from the parent's effective in-memory policy, then
restricted by the agent definition and requested isolation. The child must not reload
authority from project files and must not trust a model-supplied tool list.

The effective policy is:

```text
parent effective authority
  ∩ agent definition restrictions
  ∩ requested path ownership
  ∩ run budget
  ∩ sandbox boundary
```

The result must be recorded as a policy snapshot and used by the child session,
permission gate, sandbox launch, and evidence records.

## Proposed architecture

### Lifecycle ownership (resolved during implementation, 2026-09-09)

The original draft named a free-standing `RunService` as the lifecycle owner.
Implementation showed the parent `AgentSession` already owns every collaborator the
service would need (child construction, disposal, persistence, workspace claims), so a
second owner would have duplicated it. The settled model is:

- The session-owned `ChildRunRegistry` is the sole lifecycle owner. It holds child-run
  records, child handles, workspace claims, and persistence, and dies with the parent
  session.
- `AgentSession` is the only external surface. It exposes the lifecycle operations
  (list, wait, send, resume, interrupt, close) as thin pass-throughs over the registry.
  RPC, ACP, and the `agent` CLI subcommand family all call those pass-throughs, so every
  surface shares one owner.

A typed `RunService` facade over the registry (`core/delegation/run-service.ts`) existed
briefly for callers outside a live session, but it was never populated by any
production surface, kept a parallel record type with mostly unpopulated fields, and was
test-only. It was **deleted** on 2026-09-09 (populate-or-delete decision): the registry
is the sole owner, and `AgentSession` plus the registry's public API are the complete
boundary. Its two behaviors not covered elsewhere — failure reflected without an
explicit wait, and input accepted immediately after an awaited startup — were ported to
`test/delegation/runtime.test.ts` against `ChildRunRegistry`.

### Service operations

The lifecycle owner provides operations equivalent to:

```ts
startChild(input): Promise<RunHandle>;
sendInput(runId, input): Promise<void>;
wait(runId, options): Promise<RunResult>;
resume(runId): Promise<RunHandle>;
interrupt(runId, reason): Promise<void>;
close(runId): Promise<void>;
list(parentRunId): RunSummary[];
```

`RunService` coordinates existing collaborators. It does not execute tools itself and
does not reimplement the agent loop.

`RunHandle` exposes lifecycle operations and the child session identity. `delegate`
uses `startChild()` followed by `wait()` for foreground calls, or returns the run ID
for background calls.

`wait` must return the child's latest turn result, not the initial delegation promise:
after `send` or `resume`, retrieval follows the most recent turn, and an interrupted
first turn stays retrievable as an interrupted result instead of re-raising.

### `delegate` becomes a compatibility adapter

Keep the current public modes where compatibility requires them:

- A foreground `{agentType, task}` call starts a child and waits.
- A background call starts a child and returns its run ID.
- A retrieval call maps to `wait()`.

The tool must not own a `WeakMap`, child promise registry, policy derivation, artifact
creation, or lifecycle rules. Those belong to the session-owned registry described
above.

The existing handle field remains accepted during migration. New results should return
the stable run ID. Retrieval must accept both forms until the compatibility window ends.

### Child lifecycle

The lifecycle is a discriminated state machine:

```text
created -> running -> waiting -> completed
                    ├-> failed
                    ├-> interrupted
                    └-> closed
```

Only `running` and `waiting` accept follow-up input. Only `created`, `running`, or
`waiting` accept interrupt. `completed`, `failed`, `interrupted`, and `closed` are
terminal. Resume creates a new run attempt linked to the same child session and uses
the same policy ceiling.

Every transition is idempotent. Repeating `interrupt`, `close`, or `wait` does not
create another process, spend another budget, or duplicate evidence.

Landed decision (2026-09-09, attempts): each run carries attempt epochs on its
`ChildRunRecord` (`attempts: ChildRunAttempt[]`, `activeAttemptId`), with
`ChildRunAttempt = {id, startedAt, endedAt?, outcome?, error?, usage?}` and outcome
one of `completed | failed | interrupted | cancelled`. A launch is attempt 1. A live
run's follow-ups and steering stay inside the active attempt. Resume — historical
reattachment, or `resumeChildRun` on an interrupted live child — closes the prior
attempt with its terminal outcome and opens a NEW attempt. An interrupt with an
explicit reason marks the attempt `cancelled` and persists `cancelled: {reason, at}`
on the record; a plain interrupt settles the attempt `interrupted`. Attempt usage
snapshots from the child's own budget controller where its handle exposes one
(optional). Legacy records persisted before attempts existed load unchanged with one
synthesized attempt derived from the record's `status`/`updatedAt`.

Landed decision (2026-09-09, timeouts): a spawn may carry `timeoutMs`. The child's
LOCAL run budget is built with `maxWallTimeMs=timeoutMs`, so the existing
`AgentRunBudget` wall-time gate enforces the bound mid-run and the settlement error
path names the exhaustion `wall-time` (existing `exhaustedLimit` vocabulary). The
record also stores `deadlineMs = Date.now() + timeoutMs` at launch; `status` and
`list` observe that deadline lazily — a live running child past its deadline is
interrupted at observation time (without a cancellation reason, so it is not
recorded as user-cancelled) and reported with its `deadlineMs`.

Landed decision (2026-09-09, pollable status): `ChildRunRegistry.status(id)` (and
the `agent/status` protocol operation, plus `AgentSession.childRunStatus`) returns a
non-blocking snapshot — `{handleId, agentType, task, status, attempt: {id, outcome?},
lastResult?, cancelled?, deadlineMs?, usage?, workspace?, attempts}` — built from the
live entry or the persisted record alone, never by awaiting a turn. Unknown ids still
error; historical records are served from the persisted record. `wait` stays blocking
and unchanged.

Landed decision (2026-09-09, stale-running reconciliation and restart semantics): when
a session restores its persisted `child_run` records in a fresh process, a record whose
status is "running" cannot be live — no process owns its child. `restore()`
reconciles it in memory: the status becomes "interrupted" and the active attempt
closes with outcome "interrupted". The historical session JSONL is never rewritten by
restore; the corrected status persists with the record's next save (a resume, a
settlement). This records the honest restart semantics: a resumed run continues from
the LAST PERSISTED TRANSCRIPT BOUNDARY, not exactly-once — turns that settled after
the last save was written are re-run on resume.

Landed decision (2026-09-09, policy/sandbox/artifact/evidence linkage): every
child-run record carries a compact derived-policy snapshot — `policy: {tools,
capabilities, sandbox, maxDelegationDepth, model?, budgetScope,
aggregateBudget}` — populated at child construction from the values actually
used: the ceiling-checked tool allowlist, the admitted capability set from the
shared admission projection (`resolveAdmittedDefinition`, carried on the build
request; no surface re-derives authority — ADR 0010), the SDK's sandbox
contract string, the delegation bound it enforces, the child's resolved model
id, and the child Agent's budget wiring (`budgetScope: "session"`;
`aggregateBudget` true only when a root aggregate ceiling was configured). The
record also carries `sandboxEnforced`: true when the SDK's OS-containment
supervisor marker check passed for the parent session (always under the
"required" contract, which refuses construction without it); it never weakens
the existing sandbox contract checks. Records gain `parentSessionId` from the
runtime's parent-session seam. `ChildRunRegistry.status()` — and therefore
`agent/status`, `AgentSession.childRunStatus`, and the `agent/wait` payload —
surfaces the same linkage additively: `artifactDir`, a lazily resolved
`sessionFile` (`<artifactDir>/*_<sessionId>.jsonl`, never throwing when the
child has not persisted a transcript yet), `parentSessionId`, `policy`, and
`sandboxEnforced`, with every pre-existing field unchanged. Evidence linkage
stays the established model — the delegate launch's workflow evidence record
carries `handle`, asserted equal to the child_run record's `handleId` for the
same launch — and the canonical evidence contract gained nothing. Legacy
records without any of these fields load unchanged; the payloads simply omit
them.

Landed decision (2026-09-09, workspace states): a worktree-isolated record carries
`workspaceState: "active" | "released" | "retained-dirty" | "retained-failed" |
"missing"`; absence means "active" (legacy records predate the field, and a live
worktree is active). Release outcomes classify the record and persist immediately
even though release is fire-and-forget: removed → "released", kept dirty →
"retained-dirty", kept failed → "retained-failed". A missing/nonexistent recorded
root observed at resume classifies the record "missing" (persisted) and refuses.
Plain resume of a retained-dirty/retained-failed child still refuses — automatic
recreation of a workspace stays disabled — naming the persisted state and pointing
at explicit recovery (`recoverChildWorkspace`).

Landed decision (2026-09-09, usage and cost accounting): every child run's token
and cost usage is rolled up from the child's OWN session transcript — one owner.
`ChildRunUsageTotals = {inputTokens, outputTokens, cacheReadTokens,
cacheWriteTokens, totalTokens, cost: {input, output, cacheRead, cacheWrite,
total}, asOf, entriesCounted}` is computed on demand by the registry through the
existing session-file reading seam (`SessionManager`'s JSONL reader over
`<artifactDir>/*_<sessionId>.jsonl`), read lazily with only the LAST-COMPUTED
totals cached (keyed by file size+mtime; entry count plus last id for an
in-memory child) — never a second transcript. The numbers are summed exactly as
the provider reported them: cost is provider-reported, so cache reads are NOT
re-priced, re-counted, or double-counted, and an entry without usage counts as
zero. Assistant messages carry per-turn usage; compaction and branch-summary
entries carry their summarization call's usage, which is additional real spend
and therefore included. `ChildRunRegistry.usageTotals(id)` and
`AgentSession.childRunUsageTotals(id)` expose it; the `agent/status` snapshot
(and therefore `AgentSession.childRunStatus`, identically on RPC and ACP) gains
additive flattened `tokens` and `cost` fields beside the existing request-count
`usage`, omitted — never zero-filled, never a throw — when nothing is reachable
(an in-memory child whose handle exposes no session entries, or a legacy record
without any transcript). Attempt-level rollup: each attempt carries
`tokensAtEnd`, the CUMULATIVE-AT-END totals snapshot stamped at settlement
(`persistSettlement`) or at resume close; attempts are never attributed deltas —
the cumulative snapshot is the honest bound because turns settled after the last
persisted boundary are re-run on resume, so the transcript alone cannot
attribute usage to one epoch.

### Shared budgets

Use the existing `AgentRunBudget` and run accounting. A root run and its child runs
have separate local counters, plus a parent-owned aggregate ceiling when configured.

The policy must state both values:

```text
child budget
  limits one child

run budget
  limits the root and all descendants
```

No child may reset the aggregate parent budget by resuming or spawning another child.
Compaction remains a maintenance request under the existing policy.

Landed decision (2026-09-09), updated with the root budget contract:

- Policy inheritance. `buildChildSession` forwards the parent's already-resolved policy
  (`options.runBudget ?? settingsManager.getRunBudget()`) to every child session; a child
  never re-reads settings for a budget. The per-run policy stays per-session: it never
  creates a shared ceiling.
- Root aggregate, explicit. `CreateAgentSessionOptions.aggregateBudget` (a
  `ResolvedRunBudget`) creates ONE root aggregate controller
  (`createRunBudgetController(aggregateBudget)`) per root tree, at root session
  construction. It is never derived from `runBudget`: the aggregate exists only where
  explicitly configured.
- Parent consumption. The root session's own Agent consumes the aggregate through the
  existing `sharedBudgetController` Agent seam (composite own + shared; the root's
  `budgetScope` stays "prompt"), so each root prompt counts against the aggregate while
  keeping per-prompt local semantics, and the aggregate is never reset by a prompt. This
  supersedes the earlier recorded boundary that the parent's own runs stay outside the
  family ceiling.
- One aggregate per root tree. `buildChildSession` forwards THE SAME aggregate instance
  to every child regardless of depth, so a grandchild's consumption lands on the root
  ledger, not on a fresh per-parent ledger. The earlier per-session
  family-ledger-from-`runBudget` behavior (one ledger per session, each session the
  family parent of its direct children) is deleted: it was the bug this contract
  replaces. No descendant can reset the aggregate by resuming or spawning children;
  it only accepts consumption.
- No aggregate, no ceiling. Without `aggregateBudget` there is NO shared controller
  anywhere in the tree: every session keeps local-only budgets under the inherited
  per-run policy.
- Child budget scope. Child Agents are built with `budgetScope: "session"` (a new Agent
  option; the default "prompt" preserves upstream per-prompt semantics): one controller
  per child Agent, created at its first turn, so a `sendInput`, follow-up, or resume turn
  continues the same child budget instead of starting a fresh one.
- Composition. The child's effective controller is `createCompositeBudgetController(own,
  shared)`: every gate allows only if BOTH allow, and only accepted attempts record to
  BOTH, so a refusal never consumes the other controller's counter. The composite keeps
  the stock tool-call boundary (an already-sent request's batch is not vetoed by
  provider-request exhaustion) and `exhaustedLimit()` names the child's own limit first,
  the shared ceiling second.
- Usage snapshot. `AgentSession.aggregateBudgetUsage()` reports the root aggregate's
  counters for the whole tree -- `{providerRequests, toolCalls, maintenanceRequests,
  startedAtMs}` -- read from the one aggregate controller; `undefined` when the tree has
  no aggregate.
- Concurrency cap. `CreateAgentSessionOptions.maxConcurrentChildren` (optional; a number
  when delegation is configured) bounds simultaneously-active child runs at the
  delegation runtime's admission path. Over the limit, admission throws an actionable
  error naming the limit BEFORE any child session is built. An admitted run holds one
  slot until terminal settlement (completed/failed/interrupted), close, registry
  disposal, or launch failure releases it. `ChildRunRegistry.resumeHistorical` counts
  against the limit while running and releases on terminal settlement. The cap is
  per-runtime (a parent's direct children), and children inherit the same configured
  value for their own delegations.
- Usage and cost rollup (landed 2026-09-09, see "Child lifecycle"). Token and cost
  usage of a child run is bookkeeping, not a budget: an on-demand rollup of the
  child's own transcript (`ChildRunRegistry.usageTotals`, `tokensAtEnd` attempt
  snapshots), with provider-reported numbers summed as-is and nothing re-priced.
  The request-count snapshots (`attempt.usage`, `AgentSession.aggregateBudgetUsage`)
  remain the budget-side accounting; the rollup adds no gate and no ceiling.

### Verification at completion

Child completion can report only one of these states:

- `verified`
- `failed`
- `unavailable`
- `interrupted`
- `continued-unverified`

These are the existing `VerificationTracker` states. Do not add a second child-specific
quality state. A required verification failure keeps the child run non-successful.

Queued follow-ups settle inside the run that owns their settlement gate: a follow-up
queued onto a live child run (the `sendInput` running path does not re-gate, by design)
completes before that run settles, the child session's post-turn boundary has already
run by settlement, and the run's settled outcome is failed -- never completed.

The child result contains a compact verification summary and evidence references. Raw
command output remains in the existing artifact store.

### Parallel work and ownership

Parallel read-only children may share a workspace. Parallel writers require explicit
non-overlapping `ownedPaths` and an isolated workspace, preferably a Git worktree.

The coordinator rejects a graph before launch if two active writers claim overlapping
paths. It does not discover conflicts after edits happen. A parent may integrate a
child worktree only through an explicit existing Git workflow.

Landed decision (2026-09-09, explicit recovery): a retained child worktree is
reactivated only through `AgentSession.recoverChildWorkspace(id)` /
`ChildRunRegistry.recoverWorkspace(id)`, and only for worktree-isolated records whose
recorded root still exists. Verification is read-only through the workspace owner —
git inspection (`git -C <dir> rev-parse --abbrev-ref HEAD`, `rev-parse`, `status`)
plus the administrative entry read, nothing else: (a) the directory is a linked
worktree of the CURRENT parent workspace (its `<dir>/.git` pointer file resolves into
the repository's `.git/worktrees`), (b) the checked-out branch is
`apex-child-<short-sessionId>`, and (c) the directory sits at the owner's
`<workspaceRoot>/.apex-code/worktrees/<sessionId>` layout. On success the record's
`workspaceState` becomes "active" (persisted) and the call returns
`{workspaceState: "active", dirty}` — the child resumes in the SAME worktree with
uncommitted work intact. On any failed check the refusal names the failed check and
leaves the workspace unverified. Recovery never recreates, checks out, resets, or
force-removes anything; automatic recreation of a missing workspace stays disabled by
design.

Worktree creation and cleanup must use existing checkpoint and workspace ownership
rules where possible. If no existing owner can safely provide the operation, add that
operation to the workspace subsystem rather than embedding Git calls in delegation.

### Agent definition policy

Keep Markdown definitions as the prompt and role source. Extend their parsed policy
with optional fields only where the existing owner can enforce them:

```yaml
model: provider/model
reasoning: medium
readOnly: true
maxTurns: 40
maxRuntimeSeconds: 900
verification: [typecheck, test]
isolation: shared-read | worktree
```

Unknown fields remain invalid or ignored according to the existing frontmatter policy.
Project definitions remain gated by project trust. Project files cannot widen parent
authority or the OS sandbox.

Global agent settings may define defaults:

```toml
[agents]
enabled = true
max_concurrent_threads = 4
max_depth = 2
default_subagent_model = "provider/model"
default_subagent_reasoning_effort = "medium"
job_max_runtime_seconds = 900
```

These settings configure the coordinator. They do not create a second model router.

### Protocol and client surfaces

Expose the same lifecycle through every machine-facing adapter:

```text
agent/list
agent/spawn
agent/send
agent/wait
agent/status
agent/resume
agent/recover
agent/interrupt
agent/close
```

All nine operations exist on RPC and ACP with identical payload shapes.

- `agent/spawn` launches a background child through `AgentSession.startChildRun`
  (there is no foreground protocol spawn) and returns `{handleId, created}`. It
  accepts optional `idempotencyKey` and `timeoutMs`. A repeated spawn with the same
  `idempotencyKey` returns the EXISTING handle with `created: false` and never builds
  a second child — no budget slot consumed twice — and the key persists on the record,
  so a restarted parent dedupes from the restored records too (landed 2026-09-09).
- `agent/wait` returns the child's latest settled turn result —
  `{status, output, outcome}`, where `status` is the registry status after
  settlement — plus the additive record-linkage fields (`artifactDir`,
  `sessionFile`, `parentSessionId`, `policy`, `sandboxEnforced`) described
  under "Child lifecycle" (landed 2026-09-09); the three original fields are
  unchanged.
- `agent/status` returns the non-blocking snapshot described under "Child lifecycle"
  (landed 2026-09-09), which now also carries the same additive record-linkage
  fields (`artifactDir`, `sessionFile`, `parentSessionId`, `policy`,
  `sandboxEnforced` — landed 2026-09-09); it never awaits a turn.
- `agent/list` entries carry `{handleId, agentType, task, status, attemptCount}`;
  fields were only ever added, so older consumers keep working.
- `agent/interrupt` accepts an optional `reason`; a reason records
  `cancelled: {reason, at}` on the run and marks the attempt `cancelled` (landed
  2026-09-09).
- `agent/recover` (landed 2026-09-09) calls the explicit-recovery pass-through
  (`AgentSession.recoverChildWorkspace`) and returns
  `{workspaceState: "active", dirty}` on success; a failed verification surfaces as
  the operation's error response, naming the failed check and the unverified state.
- `agent/status` payloads for worktree-isolated runs carry `workspaceState`
  (landed 2026-09-09); `agent/list` entries gain nothing.
- `agent/status` payloads gain additive `tokens` and `cost` fields (landed
  2026-09-09): the run's token/cost rollup from the child's own transcript,
  flattened from `ChildRunUsageTotals` beside the existing request-count
  `usage`, omitted when no transcript or entries are reachable. RPC and ACP
  share the payload shape because both surface `ChildRunStatus` unchanged.

The CLI may provide commands or interactive controls that map to these operations.
RPC and ACP event streams emit the same run ID, status transitions, budget stop reason,
verification summary, and artifact references.

Approval requests remain owned by the existing permission and sandbox supervisors.
A child message cannot approve a request on behalf of the user.

## Migration and deletion plan

### Phase A: unify the internal boundary

1. Introduce `RunRecord`, `RunStatus`, and `RunService` interfaces with no behavior
   changes.
2. Adapt `buildChildSession` to produce a `RunHandle`.
3. Move background delegation storage out of the `WeakMap` and into the session-owned
   run registry.
4. Keep `delegate` output and retrieval compatibility.

Exit gate: existing delegation tests pass, and a foreground and background child use
the same `RunService` path.

### Phase B: wire existing policies

1. Attach one effective policy snapshot to each run.
2. Feed the snapshot to the derived permission store and sandbox launch.
3. Reuse the existing run budget for child and aggregate accounting.
4. Attach `VerificationTracker` to child completion.
5. Add run and parent IDs to existing evidence records.

Exit gate: tests prove no child approval widens the parent, no child exceeds the
capability ceiling, budget exhaustion is shared correctly, and verification becomes
stale after workspace changes.

### Phase C: expose lifecycle operations

1. Add list, send, wait, resume, interrupt, and close.
2. Add CLI, RPC, and ACP mappings through the same service.
3. Persist child links and terminal state through existing session and checkpoint
   formats.

Exit gate: interrupt, resume, close, and repeated operations are idempotent in both
interactive and machine-readable modes.

### Phase D: safe parallel writes

1. Add explicit path ownership to the run request.
2. Reject overlapping write claims before launch.
3. Wire worktree isolation through the workspace owner.
4. Return integration metadata without merging automatically.

Exit gate: two non-overlapping writers can run concurrently, overlapping writers are
rejected before launch, and no child writes outside its authorized workspace.

### Phase E: retire duplicate paths

After the migration gates pass:

- Delete the delegation `WeakMap` and its retrieval-specific registry.
- Delete the narrow `ChildSessionHandle` interface.
- Delete any duplicate child budget or verification types introduced during migration.
- Delete direct child lifecycle logic from `delegate.ts`.
- Keep the public `delegate` tool as an adapter until a documented compatibility
  release removes the old handle shape.

## Invariants

1. A child cannot hold a capability outside the parent's effective capability set.
2. A child cannot persist an approval into the parent's permission store.
3. A child cannot widen the parent's sandbox, writable roots, network hosts, or
   credentials.
4. A child cannot reset the aggregate run budget by resuming or delegating.
5. A terminal run never starts another process or emits duplicate terminal evidence.
6. A run ID identifies exactly one child lifecycle and remains stable across waits.
7. A child completion result names its verification status or says verification was
   unavailable.
8. Full output stays in the existing artifact store. Session and evidence records hold
   bounded summaries and references.
9. Parallel writers cannot claim overlapping paths.
10. Project-local agent definitions cannot widen authority.
11. Every lifecycle operation is authorized by the parent run or the owning client.
12. Root, child, CLI, RPC, and ACP surfaces use the same run state transitions.

## Validation

Validation must exercise the real public boundaries.

### Unit and contract tests

- State transition table, including invalid transitions.
- Idempotent interrupt, close, wait, and resume.
- Capability ceiling with `exec` expansion.
- Parent store unchanged after child approval persistence.
- Depth and concurrency limits.
- Aggregate budget across children and continuations.
- Agent-definition policy parsing and trust gating.
- Path ownership overlap detection.

### Integration tests

- Foreground `delegate` starts and waits through `RunService`.
- Background `delegate` returns a stable run ID and retrieves through the same service.
- RPC and ACP clients observe the same lifecycle events.
- A child resume preserves the policy snapshot and session linkage.
- Verification failure prevents successful child completion.
- Child artifacts use the existing artifact access rules.

### Runtime tests

- Real sandboxed child cannot widen the parent's filesystem, network, credential, or
  writable-root boundary.
- Real workspace writer can edit only its assigned worktree or paths.
- Windows remains an explicit unsupported sandbox result until a separate Windows
  boundary spec lands.

## Risks and decisions left open

- A single aggregate budget may make independent children compete unexpectedly. The
  aggregate remains explicit opt-in through `aggregateBudget`: no aggregate default is
  enabled. With an aggregate configured, the parent's own runs consume it (the earlier
  boundary that kept them outside the ceiling is superseded); whether a default should
  turn on for every session awaits replay measurements.
- Worktrees add setup and cleanup cost. Read-only parallel work must not pay that cost.
- A child resume after its workspace changed must report stale verification and rerun
  required checks.
- A stable child session ID raises session retention questions. Phase 6's session
  schema remains the owner of long-term retention policy.
- Peer messaging may become useful after lifecycle operations exist. It must be added
  as a typed message operation, not as arbitrary shared files or prompt substitution.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `core/delegation/run-service.ts` (`RunService`, `RunRecord`, `RunHandle`, re-exported `RESUME_CHILD_PROMPT`) and `test/delegation/run-service.test.ts` | implementation + tests | Deleted 2026-09-09: test-only facade with unpopulated `RunRecord` fields; the session-owned `ChildRunRegistry` is the sole lifecycle owner. Uncovered behaviors ported to `test/delegation/runtime.test.ts`. |
| `backgroundByRuntime` `WeakMap` in `delegation/runtime.ts` | implementation | Deleted; the session-owned registry owns child state. |
| `BackgroundDelegation` promise record | implementation | Replaced with child-run records and settlement-following retrieval in the registry. |
| Narrow `ChildSessionHandle.run()` and `dispose()` interface | type | Keep input compatibility temporarily, then remove after the compatibility release. |
| Retrieval-specific handle semantics in `delegate.ts` | implementation | Keep input compatibility temporarily, then remove after the compatibility release. |
| Any child-local budget type | type | Delete if it duplicates `AgentRunBudget`; use the existing agent-loop type. |
| Any child-local verification tracker | implementation | Delete; use `VerificationTracker`. |
| Any child-local artifact store | implementation | Delete; use workspace artifact ownership and retention. |
| Any second capability or permission classifier | implementation | Delete; use the canonical tool contract snapshot and derived permission store. |
| Any automatic `AGENTS.md` writer | behavior | Do not add. Learning proposals remain artifacts. |

## References

- `docs/specs/2026-08-14-delegation-and-multi-agent.md`
- `docs/specs/2026-08-28-sandbox-delegation-and-escalation.md`
- `docs/specs/2026-09-01-tool-reliability-and-execution-budgets.md`
- `docs/specs/2026-09-01-configured-verification-and-formatting.md`
- `packages/coding-agent/src/core/tools/delegate.ts`
- `packages/coding-agent/src/core/delegation/runtime.ts`
- `packages/coding-agent/src/core/delegation/agents.ts`
- `packages/coding-agent/src/core/verification-lifecycle.ts`
- OpenAI, [Codex subagents](https://developers.openai.com/codex/subagents)
- OpenAI, [Codex agent approvals and security](https://developers.openai.com/codex/agent-approvals-security)
- OpenAI, [Codex app-server](https://developers.openai.com/codex/app-server)
- `/home/nochaserz/.agents/skills/poteto-mode/SKILL.md`
