# Phase 4 tool surface

**Status:** Complete — all seven tasks (4.1–4.7) done

This plan implements `docs/specs/2026-08-13-tool-surface.md` and ADR
`0011-deferred-schema-load-path.md`. Task 4.1 is the blocking measurement and load
path; no first-party tool is marked deferred before it proves that the model can load
its schema and then call it successfully.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 4.1 Canonical load path, active registry, and absent-contract reconciliation | Done | — | Failing-first end-to-end `AgentSession` test; then load tool returns the real schema, rejects inactive/unknown names, shared `UNCLASSIFIED` fallback keeps foreign schemas full, and the production prefix measurement fixes the budget and the grep/find/ls deferral choice. Hardening pass (pre-4.7) closed a real gap: the schema loader's resolver was scoped to the full registration registry, not the session's active tool set, so it could load a registered-but-inactive tool's schema; fixed and locked in with a visibility matrix across default/no-builtin/excluded/foreign/empty active-tool-set shapes plus a direct never-defers assertion. Budget and the grep/find/ls deferral choice fixed by measurement in task 4.7 once the complete registry existed to measure (2,150 enforced / 2,300 budget / 2,706 naive) — see the measurement record below and `test/context/tool-schema-first-party.test.ts` for the end-to-end proof against a real deferred first-party tool (`grep`), not just the 4.1 test fixture |
| 4.2 Registry and contract test expansion | Done | — | Every Phase 4 tool (`tool_schema`, `todo_write`, `web_search`, `web_fetch`, `ask_user`, `plan_present`, `delegate`) is registered in `ToolName`/`allToolNames`/every factory function and enumerated by `contract.test.ts`'s and `gate-universal.test.ts`'s exhaustive invariants (1: all four contract axes present; 2: every registered tool passes the universal permission gate, both allow and deny); folded into 4.3–4.6 rather than run as a separate pass, per the plan's own order-change note |
| 4.3 `todo_write` state tool and plan-mode correction | Done | — | Real state persisted via `SessionManager.appendCustomEntry`/`getLatestTodos` (a full-list-replace snapshot, not a delta log); contract tests (capabilities, allow default, null `ruleForCall`, deferred schema, no evidence) and a schema-validation test for malformed status/missing fields; `modes.ts`'s plan-mode floor narrowed from `{fs.write, exec, delegate, state}` to `{fs.write, exec, delegate}`; mode-matrix tests plus an end-to-end permission-gate test proving `todo_write` executes under `plan` while `write`/`bash` remain denied |
| 4.4 Network tools and sandbox boundary | Done | — | `web_search` and `web_fetch` declare `net`, `ask` default, deferred schema, no evidence; `web_fetch`'s rule grammar is a host+path `minimatch` glob (`ruleForCall` returns the exact call's `hostname+pathname`, e.g. `docs.example.com/guide/intro`, so an auto-generated rule authorizes only that call — a hand-authored `docs.example.com/**` is what a human broadens); `web_search`'s `ruleForCall` is always `null` and `matches` recognizes only a literal `"*"`, since a query substring authorizes nothing meaningful. Both use `globalThis.fetch`/injected operations rather than a raw socket, verified by a spy proving the default operations call the real global fetch. Mode-matrix tests confirm `net` was never part of the plan-mode floor (unaffected by 4.3's `state` correction) and isn't `acceptEdits`-shaped. Sandbox boundary: neither tool implements or bypasses the boundary — they participate in it via `core/http-dispatcher.ts`'s existing `EnvHttpProxyAgent`, wired at CLI/child-entry startup. Proved with three real-bwrap tests: an allowed host's CONNECT tunnel relays actual HTTP response bytes (not just the proxy's "200 Connection Established" line), a disallowed host's does not, and a raw socket that ignores `$HTTP_PROXY` entirely — what a tool would do if it opened its own connection instead of calling `fetch` — still has no route, because `--unshare-net` removes it before the proxy is ever reached |
| 4.5 UI/workflow tools | Done | — | `ui`'s first implementor turned out to already have plumbing: `ExtensionRunner.createContext()`/`wrapRegisteredTool` already thread a real `ctx: ExtensionContext` (with `ctx.ui`, `ctx.hasUI`) into every tool's `execute`, extension or built-in, so neither tool needed new session wiring — they are the first to *use* it. `ask_user` (capabilities `ui`, allow default, null `ruleForCall`, deferred schema, no evidence) presents a question via `ctx.ui.select`. `plan_present` (same shape but `deferSchema: false` — called on nearly every plan-mode turn, same exclusion reasoning as the default four tools — and `evidence.emits: {workflow}`, captured as `{kind: "workflow", plan, approved}`) presents a plan via `ctx.ui.confirm` and reports the user's decision; it deliberately does not itself transition permission mode, since no such seam exists for tools or extensions today. Headless fail-closed: headless/RPC-without-UI sessions install a no-op `ui` whose `select`/`confirm` silently resolve `undefined`/`false` — indistinguishable from a real dismissal/rejection unless checked. Both tools check `ctx?.hasUI` first and throw a clear error instead, verified by tests proving `ctx.ui` is never even called when `hasUI` is false or `ctx` is absent. Mode-matrix tests confirm `ui` was never part of the plan-mode floor and (having no `fs.write`) is never `acceptEdits`-shaped, plus an end-to-end permission-gate test under `plan` mode with no explicit rule (the `allow` default alone suffices) |
| 4.6 Delegation entry contract | Done | — | `delegate` declares `{delegate}`, `ask` default, deferred schema, `evidence.emits: {workflow}` (captured as `{kind: "workflow", agentType, task}`). Rule grammar mirrors `web_fetch`'s host+path shape but for agent types: `ruleForCall` returns the exact `agentType` of the call (never a pattern the tool didn't generate), and a hand-authored glob like `explore:*` is what a human broadens to a namespace via `minimatch`. `execute` unconditionally throws "entry-point contract only... not implemented until Phase 5" — no child spawning, recursion guard, or worktree isolation belongs here per the spec's explicit non-goal, so the tool is honest about doing nothing yet rather than silently no-oping. `delegate` was already in `modes.ts`'s `PLAN_MODE_DENIED_CAPABILITIES` from the 4.3 correction; this task adds the first real-tool end-to-end permission-gate test proving the actual registered contract (not just the abstract capability) is denied under `plan` |
| 4.7 Prefix gate and phase verification | Done | — | Measured the complete 14-tool registry directly from `createAllToolDefinitions` + `buildSystemPrompt`: naive no-deferral projection 2,706 tokens, enforced prefix 2,150 tokens, budget fixed at 2,300 (`ENFORCED_PRODUCTION_PREFIX_BUDGET` in `test/context/static-prefix.test.ts`, replacing 4.1's placeholder "announced equals fully-loaded" invariant, which stopped holding once real tools started deferring). Closed 4.1's last open question by measurement: `grep`/`find`/`ls` now defer (302 of the 556-token gap), since they're read-only and not called on nearly every task. Added `test/context/tool-schema-first-party.test.ts`, an end-to-end deferred-schema proof against a real production tool (`grep`) rather than only 4.1's test fixture. Full verification: typecheck clean; `packages/agent` suite 397/398 passing (1 pre-existing skip); `packages/coding-agent` full suite 2,235–2,245/2,298 passing across repeated runs, with every failure traced individually — one genuine regression found and fixed (`test/suite/regressions/3592-...test.ts` hardcoded the full registered-tool list, stale now that the registry legitimately grew; updated to the current 14-tool list), and the remaining ~7 failures confirmed pre-existing environmental flakiness unrelated to this phase (a real dev-machine `~/.agents/skills` entry bleeding into two skills tests, a large-file timeout, external-editor temp-file races, a Radius-provider fetch timeout, and a compaction/auth-ordering race) — all reproduced identically in the pre-Phase-4 baseline run captured at the start of this work and confirmed to pass in isolation |

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
| Current production prefix, eight tools including `tool_schema` (task 4.1 landing) | 1,929 tokens (100 prompt + 7,613 serialized tool definitions) |
| Naive Phase 4 prefix, no deferral, full 14-tool registry (task 4.7) | 2,706 tokens |
| Enforced production prefix with this phase's actual deferral choices (task 4.7) | 2,150 tokens |
| Enforced Phase 4 budget (fixed by measurement, task 4.7) | 2,300 tokens — see `ENFORCED_PRODUCTION_PREFIX_BUDGET` in `test/context/static-prefix.test.ts` |
| First-party deferred set (task 4.7) | `grep`, `find`, `ls` all defer (302 of the 556-token gap between naive and enforced) — read-only tools not called on nearly every task, unlike `read`/`bash`/`edit`/`write`, which stay excluded by the phase's standing decision |

The budget is a phase fact, fixed by measurement in task 4.7 once the full registry
(all six Phase 4 tasks' tools) existed to measure. Every tool eligible for deferral —
`grep`, `find`, `ls`, `todo_write`, `web_search`, `web_fetch`, `ask_user`, `delegate` —
actually defers; the four tools excluded by explicit standing decisions (`read`,
`bash`, `edit`, `write` — called on nearly every task) and `plan_present` (called on
nearly every plan-mode turn) do not, for the same reason those four were excluded from
the start. `tool_schema` cannot defer itself.
