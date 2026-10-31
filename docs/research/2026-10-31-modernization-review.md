# Apex Code capability and modernization review

**Date:** 2026-10-31

**Status:** Complete research assessment, not an implementation plan

**Reviewed revision:** `f58925532` on `main`, package version `0.8.2`

**Scope:** Product capabilities, production wiring, selected correctness boundaries, architecture, and modernization priorities.

## Executive assessment

**Apex Code is a capable local coding harness with an immature orchestration layer, not an end-to-end software factory. Its biggest deficit is reliable integration of its existing capabilities, not the number of tools it exposes.**

The premise that Apex has no orchestration needs updating: workflow orchestration landed on October 27. It has `delegate`, scripted `workflow`, parallel workers, pipelines, phase labels, saved commands, and child lifecycle management. However, a workflow runner is not a delivery system that takes an issue through implementation, independent verification, integration, and a reviewable pull request.

My recommended order is:

1. Fix the workflow trust boundary and correctness defects before expanding autonomous execution.
2. Make workflow recovery, cancellation, limits, and result validation dependable.
3. Add task-outcome evaluations and a real browser verification loop.
4. Build a local-first delivery pipeline over existing delegation, verification, worktrees, and evidence.
5. Add scheduled/remote execution and richer collaboration only after that pipeline survives failure tests.

Do not launch a wholesale rewrite or a feature-count competition with Claude Code, Codex, or Copilot.

## Method and limitations

- Read the operating rules, glossary, roadmap, recent research, relevant specs, public tool boundaries, production registration, tests, and CI configuration.
- Inspected the normal coding-agent runtime, not just the existence of files. An upstream experimental scheduler is not evidence of a shipped Apex job service.
- Ran four existing workflow test files and additional harmless probes against the public `runWorkflow` and workflow tool boundaries. Probe children were local stubs. No model requests, real editing workers, credential reads, remote writes, or browser sessions were used.
- Probes changed directory into scratch before creating session artifacts. No production implementation files were modified.
- Used public first-party documentation fetched on October 31. Live documentation is a snapshot of what was advertised when read, not proof of a release's behavior on every platform. Dated sources are identified below.
- This is not an exhaustive security audit, benchmark, dependency-vulnerability audit, or complete end-to-end certification. Existing tests passing does not establish production safety. No full `npm test`, real-browser test, or live-model quality benchmark was run for this review. The commit hook subsequently ran the full `npm run check`, including `tsgo --noEmit`, successfully.
- No leaked or unlicensed source was accessed.

## 1. What Apex already has

These should not be proposed as missing features.

| Capability | Current evidence | Qualification |
| --- | --- | --- |
| Bounded subagents | `core/delegation/runtime.ts`, `agents.ts`, `tools/delegate.ts` | Derived authority, capability ceilings, configurable depth/concurrency, child lifecycle, optional worktrees. Four built-ins: explore, debugger, verifier, general. |
| Script orchestration | `core/delegation/workflow-run.ts`, `tools/workflow.ts`, `sdk.ts:1018-1019` | Production registration exists. `worker`, `parallel`, `pipeline`, `phase`, saved slash commands. Reliability defects below. |
| MCP and OAuth | `core/mcp/`, roadmap native MCP/OAuth rows | Not a missing integration protocol. |
| Editor integration protocol | `modes/acp/server.ts`, `translate.ts` | ACP is implemented. A polished editor experience and continuity are separate questions. |
| Semantic navigation | `tools/lsp.ts:16-40` | Definitions, references, document symbols, workspace symbols. Do not describe Apex as grep-only. |
| Context engineering | `core/context/`, `core/compaction/`, roadmap Phase 3 | Eviction, deferred schemas, compaction, workspace context. |
| Session durability and recovery primitives | `session-manager.ts`, `core/durable-state/`, delegation registry | Not equivalent to a crash-safe workflow job service. |
| Checkpoints and worktrees | `core/checkpoints/`, `core/workspace/`, README | Worktree isolation is repository separation, not OS containment. |
| Verification and repair continuations | `verification-lifecycle.ts`, `completion-condition.ts`, `verification-continue.ts` | Configured command policies, stale-result invalidation, bounded repair continuation. Not an arbitrary objective solver. |
| Reviewed memory and scoped rules | `memory-notes.ts`, `path-rules.ts`, `tools/memory-note.ts` | Accepted notes load across sessions and worktrees. Rule text is injected for matching paths. |
| Browser inspection | `tools/browser.ts` | Localhost URL, title, console, screenshot. Not interactive browser testing. |
| Optional shell confinement | `tools/bash-confinement.ts` | User-enabled bubblewrap wrapper, not full harness containment. |
| Operational telemetry | `usage-performance-store.ts`, `observability/otlp.ts` | Model-request cost and timing export exists. Not a correlated workflow trace tree. |
| Release hygiene | `.github/workflows/ci.yml`, `codeql.yml`, release scripts | Three-OS CI, packed consumer check, frozen dependency boundary, release-integrity work. Do not replace this with a generic “add CI” recommendation. |

Source paths in this table are relative to `packages/coding-agent/src/` unless qualified.

The October 22 research note is already stale as a current gap list. Its missing memory, path rules, completion continuation, session worktree, and shell confinement items have implementations now. The October 26 orchestration note also predates the workflow implementation. Historical research should remain historical, with a newer assessment superseding its conclusions.

## 2. Immediate correctness findings

These are more urgent than adding swarm messaging or another frontend.

### P0: Workflow scripts are not confined to the advertised capability boundary

**Confirmed by a harmless runtime probe.**

`workflow-run.ts:305-340` injects host objects and functions into a Node `vm` context. `runWorkflow` executes the script in that context at line 393. The script was able to obtain the host process and return only its Node version, `v26.13.0`. No environment variables, secrets, files, or network resources were accessed.

That contradicts the workflow spec's checked goal that scripts cannot access the environment or filesystem. Node's own documentation explicitly states that `node:vm` is not a security mechanism [S6]. Approval to coordinate bounded children must not silently become permission to execute arbitrary host JavaScript outside those children's tool gates.

**Recommendation:** Until repaired, treat workflow bodies as trusted host-executable code, not a contained scripting language. For untrusted/model-authored orchestration, use an actual isolation boundary with a narrow host protocol, or replace arbitrary JavaScript with a restricted declarative execution representation. Do not attempt to establish containment with another substring blacklist.

**Acceptance bar:** Adversarial scripts cannot obtain host capabilities, mutate host globals, escape time/resource limits, or bypass child permission ceilings. Test this at the public runner boundary and in the shipped runtime.

### P1: Workflow resume is successful-run caching, not reliable interrupted-run recovery

**Confirmed by code and probes.**

- `saveResume` runs only after the entire script resolves, `workflow-run.ts:393-394`.
- One completed worker followed by a script exception produced no workflow `calls.json` checkpoint.
- Call records are appended when workers finish, but replay compares the next invocation with the next stored record. An identical two-worker run in which the second worker finished first restarted both workers on replay.
- Persisted workflow records do not include the delegation handle/idempotency key needed to safely reconcile an interrupted dispatch. The delegation layer has those primitives, but the workflow layer does not use them.

**Recommendation:** Allocate stable step identities before dispatch, durably record dispatch and completion, reconcile existing child handles after restart, and bind replay to input/script version plus workspace/artifact freshness. Do not promise exactly-once external effects. Make retries safe through idempotency and reconciliation.

**Acceptance bar:** Terminate the coordinator after one step finishes and while another is running. Restart without repeating completed effects or creating duplicate children. Repeat with out-of-order completions, changed inputs, and a failed write.

### P1: Structured worker results do not receive full schema validation

**Confirmed by a probe.**

`workflow-run.ts:96-123` checks object shape and required field presence, then parses text between braces. A schema requiring a numeric `count` and forbidding extra fields accepted:

```json
{"count":"not-a-number","extra":true}
```

Property types, nested constraints, enum values, and `additionalProperties` are not validated by this implementation. Non-object JSON outputs are also not represented by the brace parser.

**Recommendation:** Apply a real, bounded JSON Schema validation contract at this external boundary, with explicit supported dialect/keywords. Provider-native structured output can improve generation but does not replace local validation. Return typed failure outcomes, not values that downstream steps assume are valid.

### P1: Concurrency, cancellation, and run limits are not consistent

**Confirmed in part by probes, with the remaining observations from source.**

- The advertised 100-call limit counts completed records, not reserved/in-flight starts. A script started and completed **101** stub workers through concurrent direct `worker()` calls.
- `parallel()` uses `inBatches`, but `pipeline()` dispatches its entire map directly. Under a configured child cap, excess admissions can become null results rather than waiting their turn.
- When `maxConcurrentChildren` is absent, `inBatches` uses the entire input length. The spec's proposed fallback of four is not implemented here.
- The workflow tool ignores `_signal`, and the runner has no deadline/cancellation input. An already-aborted direct tool call still executed a literal script.
- No VM execution timeout is passed. A CPU-bound script could block the process. This last behavior was not exercised because hanging the session was unnecessary.

**Recommendation:** One scheduler/admission path for every worker creation mechanism, reservation-based counters, explicit concurrency and total-budget defaults, cancellation propagation, deadlines, and a killable execution boundary.

### P1: A workflow name is not bound to a trusted saved body

**Confirmed at the tool boundary, not a demonstrated bypass of the entire permission system.**

`tools/workflow.ts:23-31,89-100` accepts both caller-supplied `name` and `script`. Any name skips the inline-body approval path. A named body that was never saved executed in the direct headless tool probe. Permission rules match the name, not an independently resolved body identity.

The normal saved-command path does load a file and adds an untrusted-project check in `agent-session.ts:2859-2898`. The model-facing tool can nevertheless supply the pair itself.

**Recommendation:** Separate “execute saved workflow by identity” from “approve this inline body.” Resolve saved bodies host-side and bind approval to trusted source, body digest, and scope. Validate run identifiers as identifiers rather than accepting path-like strings. Add a full permission-gate regression before declaring this boundary fixed.

## 3. What is genuinely missing or incomplete

Priority is an engineering recommendation, not a claim that every competitor implements every item.

| Priority | Gap | What exists now | What should be added |
| --- | --- | --- | --- |
| P1 | **Durable work/job control plane** | Sessions, child registry, leases, journal, scripted workflows | Persistent jobs and steps with dependencies, ownership, attempts, blocked states, retry policy, cancellation, checkpoints, and restart reconciliation. The plan must survive the coordinator's context and process. |
| P1 | **Delivery pipeline from accepted task to reviewable change** | Shell, worktrees, verification, evidence, extensibility | A first-class chain: intake, acceptance criteria, implementation, verification, integration, PR artifact, CI feedback, human approval. A model can run `gh` today, but that is not a durable product workflow. |
| P1 | **Outcome-based harness evaluations** | Unit/integration tests and synthetic replay fixtures | Representative repository tasks graded on actual resulting code and behavior, multiple trials, provider matrix, failure taxonomy, cost per successful task, repair rate, and safety regressions. |
| P1 | **Interactive browser verification** | One localhost screenshot/console capture | Click, type, wait, navigation, DOM/accessibility inspection, assertions, traces, screenshots linked to acceptance checks, and real-Chrome integration tests. Start with local apps rather than broad access to signed-in personal tabs. |
| P1 | **Practical isolation for unattended work** | User-enabled bash wrapper and operator-supplied container/VM | Supported environment profiles, credential separation, writable mounts, network policies, dependency setup, cleanup, and explicit platform coverage. Keep shell confinement distinct from whole-worker containment. |
| P2 | **Integration of parallel changes** | Worktree creation and child write claims | Patch/commit handoff, base revision tracking, conflict detection, ordered integration, post-integration tests, dirty-tree retention, and rollback. Parallel editing without integration ownership only moves the bottleneck. |
| P2 | **Workflow observability and operator controls** | Child list/wait/send commands, phase counts in tool result, per-model OTLP spans | Durable job view, step dependency/status display, pause/cancel/retry controls, artifact links, and correlated job → step → child → model/tool/verification traces. |
| P2 | **Scheduled and event-driven work** | Hooks and headless/SDK entry points | Explicitly configured issue/PR/CI/webhook/schedule triggers, deduplication, authentication, scoped permissions, approval queues, and budgets. Start with an external scheduler adapter, not necessarily a new always-on daemon. |
| P2 | **Reproducible remote execution** | Local CLI plus operator-owned environments and experimental upstream server code | Optional self-hosted runner interface, environment manifest, artifact transfer, remote cancellation/recovery, and credential delegation. A cloud service is not required. |
| P2 | **Evidence-backed completion across multiple requirements** | One selected verification policy, repair continuation, source evidence | Acceptance criteria mapped to checks/artifacts, required-versus-optional checks, changed-revision identity, and explicit blocked/unverified states. “Command passed” and “user outcome delivered” are different facts. |
| P2 | **Useful long-lived memory management** | Reviewed inbox, accepted notes, bounded loading, scoped rules | Relevance selection, provenance, supersession, conflict handling, expiry, search/edit/delete UI, and secret/privacy controls. Keep human review rather than blindly copying auto-memory defaults. |
| P3 | **Semantic refactoring support** | LSP navigation and diagnostics, text edits/patches | Optional rename/code-action operations with permissioned workspace edits and post-change checks. Build only if coding-task evaluations show a real improvement. |
| P3 | **Adaptive model selection** | Provider breadth, configured roles, fallback/credential mechanisms | Quality-and-cost-aware routing backed by measured outcomes. Do not add a speculative router before an evaluation suite can tell whether it helps. |

### The software factory distinction

For this review, a software factory means a **repeatable delivery system**, not “many agents running at once.” Its minimum useful unit is:

```text
Accepted task + acceptance criteria
  -> durable work plan
  -> bounded worker in a known environment
  -> patch and verification artifacts
  -> integration and tests on the combined result
  -> reviewable pull request
  -> explicit human approval for merge/release
```

Failures, restarts, duplicate trigger delivery, exhausted budgets, and unavailable credentials must be ordinary states in that system. Autonomous production deployment is not a prerequisite and should not be the default.

The October 28 Copilot documentation explicitly describes continuity across clients, environments, repository workflows, and automations [S1]. That is a useful current comparator for delivery experience. The older Codex launch already established isolated tasks producing evidence and reviewable PRs as a baseline [S2]. Neither proves that Apex must become a hosted SaaS product.

### Important qualifications

- **Peer-to-peer agent teams are missing by design**, but they are not required for a factory. Use them only when tasks demonstrably benefit from persistent collaboration. A deterministic dependency graph with typed handoffs is often easier to recover and audit.
- **No built-in shell sandbox** is now an inaccurate blanket statement. Apex has optional confinement. However, `bash-confinement.ts:50-65` exposes `/` read-only, makes the current directory writable, and disables networking. Read-only host files remain readable, so this is not credential isolation. It covers bash, not every executable extension or worker process. It rejects Windows and has no native macOS implementation in this file.
- **No memory** is inaccurate. The weakness is retrieval and lifecycle: `memory-notes.ts:66-92` loads sorted accepted notes until the size limit, not task-relevant notes with freshness/provenance scoring.
- **No observability** is inaccurate. `observability/otlp.ts:10-14,102-105` explicitly emits separate model-attempt spans with fresh trace IDs, not a correlated delivery trace.
- **No persistence** is inaccurate. The missing layer is dependable job/step recovery and coordination over existing state, not a reason to replace all session storage.
- **No editor integration** is inaccurate. ACP exists. A separate IDE extension should earn its cost through actual user workflow gaps.

## 4. What feels dated

### A session-centric product model for work that now spans sessions

The terminal conversation is still the primary unit of ownership. Modern asynchronous engineering needs the job and its accepted deliverable to remain identifiable after the CLI closes, the model changes, or another client takes over. Keep the session, but make it one participant in a job rather than the only durable definition of the work.

### Text output as an integration contract

Worker result parsing and null-on-failure fan-out are too weak for downstream automation. Use a result envelope such as success, failed, cancelled, or blocked, with typed output and artifact references. Preserve enough failure detail to distinguish “nothing found” from “the worker never ran.”

### Verification based on tool names rather than declared tool behavior

`verification-continue.ts:10,25-26` maintains a separate `MUTATING_TOOLS` set. This can miss mutating extensions/MCP tools and treats every bash call as a mutation. It also conflicts with the repository rule against independently re-deriving tool classification.

Use the existing contract projection and observed workspace changes. Do not add another heuristic classifier. This is a source-confirmed design issue, not an exercised extension-bypass test.

### Large files as integration bottlenecks

The inspected tree has:

- `modes/interactive/interactive-mode.ts`: **7,751 lines**.
- `core/agent-session.ts`: **5,704 lines**.
- `core/delegation/runtime.ts`: **1,905 lines**.

These are physical line counts from `wc -l`, not complexity scores or performance measurements. They identify ownership boundaries worth inspecting, not an automatic rewrite mandate. Extract newly owned job/step/verification services behind narrow interfaces as work demands it. Preserve upstream merge legibility.

`docs/upstream-log.md` and ADR 0003 already track merge-cost pressure. A 159-conflicted-hunk ceiling exists, and recent merges have breached it. That makes a sweeping cosmetic refactor especially unattractive.

### Documentation that declares success more strongly than the implementation supports

Concrete examples:

- README lists two built-in agents, while `delegation/agents.ts:105-133` defines four.
- The coding-turn plan says nothing is committed, despite the clean reviewed branch containing the implementation files. Its slice status also disagrees with the roadmap.
- The workflow spec claims containment and a default concurrency fallback that the implementation does not provide.
- The root `tui-plan.md` has no required status line and sits outside the plan convention. Do not delete it without establishing ownership and whether it is complete.
- The glossary/architecture describe a bundled SpecEngine, but the inspected production source and example-extension searches did not identify that implementation. Reconcile the claim rather than assuming the old extension is a shipped factory foundation.

`npm run check:docs` passes despite these discrepancies. Its lifecycle checks are useful, but they do not validate product truth. Add targeted executable claims and generated capability inventories, not another progress document.

## 5. What I would remove, replace, or stop doing

### Remove or replace after a tested migration

1. **The claim that Node VM is a security sandbox.** Replace the execution boundary, or explicitly limit the feature to trusted code until it is replaced.
2. **Ad hoc schema checking and brace-slicing as the structured-result contract.** Replace with validated typed outputs and bounded repair.
3. **Independent hard-coded mutation classification.** Use the canonical tool contract and observed changes.
4. **Process-global approval cache as workflow authority.** `approvedBodies` is module-global. Scope approval to the session/trust context and body identity, rather than a process-wide remembered string or caller-supplied name.
5. **Stale status claims and orphaned completed plans.** Verify ownership and completion before deleting any plan. Preserve historical research, but mark newer conclusions through the current roadmap/spec structure.
6. **Unreachable duplicate execution paths, if a reachability audit proves them unused.** Experimental mini/micro/pico and server code are candidates for an ownership/reachability inventory, not automatic deletion. Some are upstream surfaces or exported APIs. Respect ADR 0001 and compatibility promises.

### Stop treating these as automatic priorities

- Adding more agent roles before existing worker results, budgets, cancellation, and integration are reliable.
- Restoring the old daemon merely because a factory sounds like it needs one. The previous daemon was removed because nothing constructed it. Introduce a service only for a concrete scheduling/recovery responsibility.
- Adding a marketplace, mandatory hosted backend, voice mode, or a bespoke desktop app simply to match a competitor's feature list.
- Using token counts and replay consistency as evidence that real coding success improved.
- Calling a screenshot tool an end-to-end browser tester.
- Treating every old non-goal as an eternal product prohibition. Revisit a decision explicitly when the target product changes.

### Keep

Provider neutrality, MCP, ACP, extensions, human-reviewed memory, permission contracts, delegated capability ceilings, worktree separation, source-captured evidence, checkpoint history, offline replay, release checks, and upstream merge discipline are valuable foundations. A terminal-first interface is not inherently dated. JSONL sessions are not inherently dated either.

ADR 0013 prohibits **unowned hosted-service defaults**, not all optional remote execution. A user-selected self-hosted runner or explicitly configured cloud integration can fit that policy. A factory does not require discarding the local-first positioning.

## 6. Suggested modernization sequence

This is a recommendation, not a new live plan or future-phase specification.

| Order | Deliverable | Proof that it works |
| --- | --- | --- |
| 1 | Harden existing workflow boundary | Host-access probe rejected, saved identity bound to body, aborts respected, resource limits enforced. |
| 2 | Durable step execution | Crash/restart and out-of-order replay tests preserve completed effects, reconcile running children, and enforce caps for every dispatch path. |
| 3 | Evaluation and browser foundation | Real repository tasks with acceptance tests, real local-browser flows, repeated trials, cost/success results, no hidden network or repo-state contamination. |
| 4 | One vertical delivery workflow | One selected issue becomes a verified reviewable change with artifacts and explicit approval. Re-run and restart it without duplicate work or submissions. |
| 5 | Parallel integration and operator view | Two independent changes integrate safely, conflicting changes block clearly, combined tests run, and a user can inspect/cancel/retry each step. |
| 6 | Triggers and optional runners | Scheduled or issue-triggered jobs survive duplicate events, offline periods, expired credentials, and runner restarts within explicit budgets. |
| 7 | Optional richer collaboration | Add peer messaging, richer IDE/desktop controls, cross-repo work, or routing only when the prior stages expose a measurable need. |

**Best next investment:** harden the existing orchestration and implement one narrow task-to-reviewed-PR workflow. That will expose the real missing abstractions more accurately than designing a general-purpose swarm platform first.

## 7. Verification record

### Existing workflow tests

Command:

```bash
npm run test --workspace packages/coding-agent -- test/delegation/workflow.test.ts test/delegation/workflow-tool.test.ts test/delegation/workflow-files.test.ts test/delegation/workflow-command.test.ts
```

Actual output summary, with terminal color codes omitted:

```text
Test Files  4 passed (4)
Tests       27 passed (27)
Start at    02:29:38
Duration    11.36s (transform 8.41s, setup 0ms, import 15.30s, tests 493ms, environment 1ms)
Command finished with exit code: 0
```

### Additional safe public-boundary probes

Local probe artifact: `$JCODE_SCRATCH_DIR/apex-oct31-review-probes.mts` (not tracked).

Command:

```bash
npx tsx --tsconfig tsconfig.runtime.json "$JCODE_SCRATCH_DIR/apex-oct31-review-probes.mts"
```

Actual observations:

```json
{
  "vmHostAccess": "v26.13.0",
  "schemaMismatchAccepted": { "count": "not-a-number", "extra": true },
  "completedCallPersistedAfterLaterFailure": false,
  "childrenRepeatedOnIdenticalParallelReplay": 2,
  "callsThroughAdvertised100Cap": 101,
  "namedUnsavedScriptWithAbortedSignal": "42"
}
```

These are defect observations, not passing acceptance tests. They use stub workers to isolate harness behavior and do not claim model quality, live-provider compatibility, or a full permission-gate exploit. The version-only host-access check demonstrates the claimed VM boundary is absent without reading sensitive state.

### Documentation lifecycle

Command:

```bash
npm run check:docs
```

Actual output:

```text
Documentation lifecycle validation passed.
```

### Revision references

The report's first commit also ran `npm run check` through the repository hook. It completed successfully, including lint, documentation and dependency checks, typechecking, and the browser-bundle smoke check. That smoke check is not a real browser interaction test. Key output:

```text
Checked 1290 files in 12s. No fixes applied.
Documentation lifecycle validation passed.
Every process-spawning test retries its recursive scratch cleanup.
packages/coding-agent/npm-shrinkwrap.json is up to date.
packages/coding-agent/install-lock is up to date.
All pre-commit checks passed!
```

Both `git cat-file -t f58925532` and `git cat-file -t e8dd0157f` returned `commit`. The latter is the October 27 workflow implementation commit. The worktree was clean before this research report was written.

## 8. Sources

### External primary sources

- **[S1] GitHub Copilot on GitHub.com and GitHub Mobile.** First-party live documentation, fetched 2026-10-31. Explicitly dates its new cloud experience to **2026-10-28**. Describes sessions across clients, environments, repository tasks, review, and automations. <https://docs.github.com/copilot/concepts/coding-agent/coding-agent>
- **[S2] OpenAI, Introducing Codex.** **2025-05-16**, with June 3 update. Historical baseline only, and the page labels itself outdated. Supports isolated task execution, verification evidence, and reviewable PR delivery, not current model or product-limit claims. <https://openai.com/index/introducing-codex/>
- **[S3] Claude Code, Orchestrate subagents at scale with dynamic workflows.** Live official documentation, fetched 2026-10-31. Distinguishes subagents, teams, and script workflows, and documents background progress controls and replay behavior. <https://code.claude.com/docs/en/workflows>
- **[S4] Anthropic, Demystifying evals for AI agents.** **2026-01-09**. Defines tasks, repeated trials, graders, traces, and actual environmental outcomes. <https://www.anthropic.com/research/demystifying-evals-for-ai-agents>
- **[S5] Anthropic, Effective harnesses for long-running agents.** **2025-11-26**. Supports durable acceptance criteria, incremental progress, clean handoffs, and user-facing browser verification. Its particular progress-file pattern is not a recommendation to violate this repository's documentation rules. <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>
- **[S6] Node.js VM documentation.** Live official documentation, fetched 2026-10-31. Explicit warning: the VM module is not a security mechanism for untrusted code. <https://nodejs.org/api/vm.html>
- **[S7] Claude Code with Chrome.** Live official documentation, fetched 2026-10-31. Concrete comparator for navigation, interaction, DOM/console debugging, and user-flow testing. Its signed-in-browser access model is not recommended as Apex's default. <https://code.claude.com/docs/en/chrome>

These are observed practices, not a formal universal “October 2026 standard.” Competitor documentation describes intended behavior, not independently verified safety or quality.

### Main repository evidence

- [Roadmap](../roadmap.md), especially follow-ups at lines 147-154.
- [Workflow specification](../specs/2026-10-26-workflow-orchestration.md).
- [Workflow runner](../../packages/coding-agent/src/core/delegation/workflow-run.ts).
- [Workflow tool](../../packages/coding-agent/src/core/tools/workflow.ts).
- [Delegation runtime](../../packages/coding-agent/src/core/delegation/runtime.ts).
- [Browser tool](../../packages/coding-agent/src/core/tools/browser.ts).
- [Shell confinement](../../packages/coding-agent/src/core/tools/bash-confinement.ts).
- [Verification lifecycle](../../packages/coding-agent/src/core/verification-lifecycle.ts).
- [Verification continuation](../../packages/coding-agent/src/core/verification-continue.ts).
- [Replay metrics](../../packages/coding-agent/src/testing/replay/metrics.ts) and [synthetic corpus provenance](../../fixtures/corpus/README.md). In particular, replay `wallTimeMs` is deliberately zero, not a latency measurement.
- [OTLP scope](../../packages/coding-agent/src/core/observability/otlp.ts).
- [Memory store](../../packages/coding-agent/src/core/memory-notes.ts).
- [Fork boundary](../adr/0001-fork-boundary.md), [merge-cost policy](../adr/0003-upstream-merge-cadence.md), and [hosted-default policy](../adr/0013-no-unowned-hosted-service-defaults.md).

## Bottom line

Apex does not need to become a clone of every other assistant. It needs to turn its existing permissioned, evidence-producing local harness into a dependable delivery system. The missing factory layer is real. The more immediate risk is building that layer on orchestration guarantees that currently do not hold.
