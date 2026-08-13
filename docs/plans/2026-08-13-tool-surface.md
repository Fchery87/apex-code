# Phase 4 tool surface

**Status:** Active

This plan implements `docs/specs/2026-08-13-tool-surface.md` and ADR
`0011-deferred-schema-load-path.md`. Task 4.1 is the blocking measurement and load
path; no first-party tool is marked deferred before it proves that the model can load
its schema and then call it successfully.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 4.1 Canonical load path, active registry, and absent-contract reconciliation | Not started | — | Failing-first end-to-end `AgentSession` test; then load tool returns the real schema, rejects inactive/unknown names, shared `UNCLASSIFIED` fallback keeps foreign schemas full, and the production prefix measurement fixes the budget and the grep/find/ls deferral choice |
| 4.2 Registry and contract test expansion | Not started | — | Registry factories, `ToolName`, enumeration, representative params, and universal gate cover every Phase 4 tool; each contract has all four axes |
| 4.3 `todo_write` state tool and plan-mode correction | Not started | — | Real state persisted in the workspace/session-facing store; rule grammar tests; mode matrix proves plan allows state while mutating filesystem/exec/delegate remain denied |
| 4.4 Network tools and sandbox boundary | Not started | — | `web_search` and `web_fetch` use the declared network boundary and rule grammars; permission-mode matrix; direct host policy plus Linux/macOS sandbox tests prove child network posture is unchanged |
| 4.5 UI/workflow tools | Not started | — | `plan_present` and `ask_user` implement the structured UI boundary, workflow evidence, and mode matrix; headless behavior fails closed where human interaction is required |
| 4.6 Delegation entry contract | Not started | — | Additive delegation entry point with `delegate` capability and agent-type grammar only; no child execution, recursion, or worktree implementation before Phase 5 |
| 4.7 Prefix gate and phase verification | Not started | — | Direct production-prefix test from `createAllToolDefinitions` + `buildSystemPrompt`, naive no-deferral projection recorded, enforced budget from 4.1, deferred-tool end-to-end test, all narrow suites, typecheck, and full `npm test` |

## Order changes

None. Task 4.1 is intentionally first because `deferSchema: true` is unusable until
the load path exists. 4.2 depends on the registry shape from 4.1; 4.3–4.6 are
independent feature slices after that blocker; 4.7 is last because its budget and
registry-wide assertions must observe the complete Phase 4 surface.

## Task 4.1 — canonical load path and measurement

### Red

1. Add the public-boundary test through `createHarness`/`AgentSession` with a scripted
   provider response sequence: first call `tool_schema`, then call a deferred tool
   using its real required argument. Assert the first request announces the deferred
   tool with the stub, the schema result contains the real JSON schema, and the second
   request has a valid call that executes.
2. Add the drift test that projects an unclassified foreign tool through the pipeline
   and resolves it through the permission gate; assert both use the same fallback and
   the foreign schema remains full.
3. Add the direct production prefix measurement. Record the seven-tool baseline and a
   no-deferral Phase 4 projection; leave the budget assertion failing until the
   measured first-party deferral set is chosen.

### Green

- Implement `tool_schema` as an additive, always-loaded tool over the active registry.
  Keep schema results ordinary tool-result content; track loaded names/request-local
  schema state so the next provider request projects the selected real schema.
- Change `UNCLASSIFIED` to remain conservative on capability, permission, eviction, and
  evidence while setting `context.deferSchema: false`; import and use it from both
  `projectToolSchemas` and the gate's contract lookup path. Do not rederive the
  fallback in either seam.
- Measure the actual production prefix using `ceil(serialized-length / 4)`. The budget
  must be fixed from the measured set and recorded in the task row and roadmap; it is
  not the replay corpus's 707 and is compared against the naive no-deferral projection.

### Refactor

Keep the schema tool and registry projection separate from provider-specific adapters.
The explicit load result must remain observable through the ordinary agent loop, and
foreign tools must remain fully announced unless they explicitly carry a contract.

## Shared implementation rules

- Write the failing test before each implementation slice and run the narrowest test.
- Tests that drive sessions or write state use `mkdtemp`/`chdir` and clean up; no test
  writes to the repository's own `.apex-code` state.
- Every new tool declares `capabilities`, `permission`, `context`, and `evidence` in
  its definition. Rule tests include positive and negative cases; `null` from
  `ruleForCall` is asserted where a call is not generalizable.
- New network tools do not weaken the deny-all sandbox. If a tool intentionally runs
  in the supervisor rather than the sandboxed child, the definition and test state
  that asymmetry explicitly.
- Delegation is a declared entry surface only; Phase 5 owns spawning, ceilings,
  recursion, artifacts, and worktree execution.

## Measurement record to complete in 4.1

| Measurement | Result |
| --- | --- |
| Current production prefix, seven tools | 1,217 tokens (28 prompt + 1,189 schemas) |
| Naive Phase 4 prefix, no deferral | ~2,400 tokens (must be recomputed from actual definitions) |
| Enforced Phase 4 budget | Pending 4.1 measurement |
| First-party deferred set (`grep`/`find`/`ls`) | Pending 4.1 measurement |

The budget is a phase fact, not a speculative constant. Once 4.1 fixes it, update
this table, the roadmap correction, and the Phase 4 verification section in the same
commit that closes the task.
