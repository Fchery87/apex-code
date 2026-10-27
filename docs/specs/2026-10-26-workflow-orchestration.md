# Spec: Workflow orchestration over the delegation runtime

**Status:** Landed

Landed 2026-10-27. The runner, the tool, the loader, `/<name>`, and `phase()` are tested. A workflow closes each child when it finishes, so `apex-code agent list` stays a list of live child runs. Phase titles, the call count under each, and a warning past 25 calls are on the tool result. A run stops at 100 calls. `/<name>` in an untrusted project asks even when a user rule allows the name.

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Created | 2026-10-26 |
| Last updated | 2026-10-27 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | **Preserves compatibility.** `delegate` keeps its name, schema, capability, and rule grammar. Sessions written before this change have no workflow records and need none. The new tool is additive and deferred, so it is not in the static prompt prefix. Saved workflow files are a new directory. Nothing reads them except the new loader. |

## Executive summary

`delegate` runs one child and returns its result to the parent. A fan-out of N children is N results in the parent's transcript, and the parent has to remember which result belonged to which item.

This spec adds a tool that runs a JavaScript script. The script calls the existing delegation runtime. Intermediate results stay in the script. The parent receives the script's return value. A second run of the same script reuses a child's result when that child's prompt and inputs did not change.

## Context and motivation

- `docs/research/2026-10-26-subagent-orchestration.md` is the only channel for the behavior this spec adapts. It records Claude Code dynamic workflows (changelog 2.1.154) and the Managed Agents `multiagent_20261001` type. ADR 0002 still applies. No prompt text, field name, or script API name is taken from those docs.
- `docs/adr/0008-delegation-authority.md` is the authority model. A workflow child is an in-process derived child. This spec does not reopen that decision.
- `docs/specs/2026-08-14-delegation-and-multi-agent.md` is the landed delegation contract this spec consumes. Inter-agent messaging stays a non-goal there and here.
- `docs/specs/2026-09-09-run-and-child-session-architecture.md` is the child-run registry, concurrency slot, attempt record, and usage rollup the script calls through.

## Current state

`runDelegation` in `packages/coding-agent/src/core/delegation/runtime.ts` admits a child through `resolveAdmittedDefinition`. That function refuses an unknown agent type, a call at `maxDelegationDepth` (the production default is 2, set in `packages/coding-agent/src/core/tools/index.ts`), and a requested capability the parent does not hold. The refusal names the agent type, the bound, or the capability.

`packages/coding-agent/src/core/permissions/modes.ts` denies `fs.write`, `exec`, and `delegate` in plan mode. `delegate` is `ask` by default, `deferSchema: true`, and emits a `workflow` evidence record.

`apex-code agent list|wait|send|resume|interrupt|close` (`packages/coding-agent/src/cli/agent-lifecycle.ts`) prints child runs from `session.listChildRuns()`. `/tasks` toggles the `todo_write` panel and does not list children. `maxConcurrentChildren` is optional. When it is unset, the registry admits every child.

Built-in agent types are `explore`, `debugger`, `verifier`, and `general`. `explore` cannot edit or run commands. `general` can edit and does not hold `delegate`.

The script runner, the workflow tool, and the `.apex-code/workflows/` loader are in the tree.

## The problem

Ask for the same check across every file in a directory. The parent delegates one child per file, then reads every child's output back into its own context before it can rank them. The transcript holds the searches, not the answer. A second attempt repeats the children that already finished, because nothing stored their results outside the transcript.

That is the failure a workflow exists to avoid. The orchestrator is a context window.

## Goals

- [x] A script that returns a literal produces that value and starts no child.
- [x] A script cannot read the filesystem, the environment, the network, or the clock. `Date.now()`, `Math.random()`, and `new Date()` throw before any child starts.
- [x] `worker()` starts a child only through `runDelegation`. A requested capability the parent lacks fails the call with the capability name, and no child session is built.
- [x] Plan mode denies the new tool the same way it denies `delegate`.
- [x] A child whose definition includes `delegate` still stops at `maxDelegationDepth`.
- [x] `parallel()` runs calls under `maxConcurrentChildren`. One failure is `null` at that index. The other calls return.
- [x] A schema the runtime can prove contradictory fails before a child is built. Invalid JSON gets one follow-up on the same child, then a named failure.
- [x] Relaunching the same script in the same session starts no child. Changing call 2 reruns call 2 and every call started after it, and does not rerun call 1.
- [x] The first run of a script body the model just wrote asks the user before any child starts. Deny starts nothing.
- [x] `phase()` titles and the call count under each are on the workflow tool result. `apex-code agent list` stays a list of live child runs. A workflow child is closed when it returns, so it is not a row there.
- [x] A saved script in a trusted project runs as `/<name>`. Saving through a symlink is refused. An untrusted project asks even when a user rule allows the name, and a denial starts nothing.

## Non-goals

- [ ] **Inter-agent messaging.** Children return values. They do not address each other. The 2026-08-14 spec declined this, and a workflow does not need it.
- [ ] **Replacing `delegate`.** One child, and a follow-up to that child, stay a `delegate` call.
- [ ] **A mode that turns every task into a workflow.** The tool runs when the model calls it or the user names a saved script.
- [ ] **Filesystem or shell access for the script.** If the script can do the work, the capability ceiling is bypassed. Children do the work.
- [ ] **An advisor model.** A child definition can already name a model. A mid-turn second model is a separate decision and spends tokens the user did not ask to spend.
- [ ] **A new progress panel.** `/tasks` stays the todo panel.
- [ ] **Provider-native structured output.** The first version parses the child's final message. A provider response format can replace that parse later without changing the script.
- [ ] **Copying Claude Code's names.** The research note records their API. The names in this spec are Apex Code's.

## Proposed solution

### Names

| Thing | Name | Why this name |
| --- | --- | --- |
| Tool | `workflow` | Matches the evidence record kind the child runs already emit |
| One child | `worker(prompt, options)` | Says what it starts. Avoids the other product's function name |
| A set of calls | `parallel(calls)` | The calls run together and the script waits |
| One call per item | `pipeline(items, fn)` | `fn` returns the `worker` call for one item |
| A progress label | `phase(title)` | Groups the following calls on the tool result |
| Saved command | `/<name>` | Same slash surface as a skill, different loader |

`options` on `worker` is `agentType`, `schema`, `label`, and `isolation`. `agentType` defaults to `explore`, so a script has to opt into writes by naming `general` or another definition that holds `edit`. `isolation: "worktree"` is forwarded as the child's workspace request. Owned paths default to none.

### The isolate

One fresh isolate per run. Top-level `await`. No `import`, no `require`, no `fetch`, no `process`, no filesystem handles, no timer. The four functions above and an `args` value are the whole global surface. `Date.now`, `Math.random`, and a no-argument `new Date` throw. Time and randomness enter through `args`, which is the JSON value the tool call passed, or `undefined`.

The script is at most 64 KB. A larger body is refused before the isolate starts.

### Admission

`worker()` calls `runDelegation`. It does not construct a session. Depth, the capability ceiling, the derived permission store, the artifact directory, worktree ownership, overlapping write claims, and the concurrency slot stay in the delegation runtime.

The workflow tool's contract is `{delegate}`, `ask`, `deferSchema: true`. Plan mode already denies `delegate`, so it denies this tool with no new mode rule. Evidence stays `workflow` records, one per `worker()` call, emitted by `delegate`'s existing capture when the child is launched. The workflow tool itself emits one record naming the script's hash and the run id.

### Caps

| Cap | Value | On breach |
| --- | --- | --- |
| Concurrent children | the session's `maxConcurrentChildren`, or 4 when unset | `runDelegation` throws naming the limit. The script sees the throw |
| Calls in one `parallel` or `pipeline` | 256 | the call throws naming the length. No child starts |
| Calls in one run | 100 | the next `worker()` throws naming the count |
| Script size | 64 KB | the tool throws before the isolate starts |

Passing 25 calls records a warning on the run result. The run continues. The warning is not an `agent list` row.

### Structured output

`schema` is a JSON schema object. Before `buildChildSession`, the runtime rejects a schema it can prove contradictory: a `required` key that `additionalProperties: false` excludes, or a type that is both a string and a number. The error names the contradiction.

The child's task text says to return one JSON value and includes the schema. The runtime parses the final message. On a parse or schema failure it calls the child's `followUp` once with the failure text. A second failure throws, naming the last failure. The parent does not see the retry.

### Resume

Under the parent session's `delegations/<runId>/calls.json`, one record per `worker()` call: the hash of `(prompt, agentType, schema, JSON.stringify(args))`, the start order, and the returned value or the failure. On a second start of the same script body in the same session:

- A completed call whose hash matches returns the stored value and does not start a child.
- The first call whose hash differs, and every call the script starts after it, runs again.
- A call that failed runs again, and so does every call started after it.

Order is start order, not source order. `parallel` records the order it started calls.

Stopping a run interrupts its children through the registry and keeps the records. A relaunch refuses to start while a child from the stopped run still holds a slot.

### Approval and saving

The first run of a script body in a session shows the body and the `phase` titles and asks before any child starts. Deny starts nothing. There is no setting that skips this for a body the model just wrote.

A saved file is `<config>/workflows/<name>.js` or `.apex-code/workflows/<name>.js`. It starts with frontmatter (`name`, `description`) and the script body. The workflow loader parses that frontmatter. `skills.ts` does not load the file and does not execute the body. Project beats user on the same name. A trusted project may allow a saved name with a `workflow` permission rule, matched by the same glob grammar `delegate` uses for `agentType`. An untrusted project always asks. The save refuses a symlink at `.apex-code`, at `workflows`, or at the target file.

`/<name>` loads the file and calls the same tool. Args after the name are JSON when they parse as JSON, and a string otherwise.

### Progress

`phase(title)` appends a title. Every `worker()` started after it increments that title's call count until the next `phase()`. The workflow tool result carries `details.phases` as `{ title, calls }[]`, in call order.

`apex-code agent list` is not this surface. It prints live child runs. A workflow closes each child when the child returns, so the row would vanish before a user could read it. Token totals stay on the child usage rollup the registry already keeps for a child that is still running. There is no workflow row and no new panel.

The tool runs the script and returns the script's value as JSON. It does not return a background handle. The full call records are in `delegations/<runId>/calls.json` when the session has a directory and the call passed a `runId`.

### Components

| Component | Change | File(s) |
| --- | --- | --- |
| Isolate | Runs the script with the four functions and nothing else | `packages/coding-agent/src/core/delegation/workflow-isolate.ts` (new) |
| Runner | Maps `worker()` to `runDelegation`, stores call records, enforces caps | `packages/coding-agent/src/core/delegation/workflow-run.ts` (new) |
| Tool | Schema, contract, approval gate, handle retrieval | `packages/coding-agent/src/core/tools/workflow.ts` (new) |
| Loader | Reads saved scripts, refuses symlinks, registers `/<name>` | `packages/coding-agent/src/core/delegation/workflow-files.ts` (new) |
| Status | Phase counts on the tool result. `agent list` is unchanged | `packages/coding-agent/src/core/tools/workflow.ts` |

### Seam invariants

`beforeToolCall`: every child tool call still goes through `evaluateToolCall` with the derived store. The script never calls a tool.

`ruleContent`: the new tool's rule is the saved script name, or `*` for an unsaved body. A rule written for `delegate` does not match `workflow`, and the reverse is also true.

Evidence: child calls emit their own `workflow` records into the child session, as `delegate` does today. The parent tool emits one record for the run. No tool call is captured by its caller instead of at the source.

`transformContext`: the script's values are not messages. Nothing from a child transcript enters the parent except the return value.

## Deletion inventory

Nothing existing is removed. This is additive. `delegate` stays the one-child path, and a workflow that called it would put the orchestration back in the parent transcript, which is the failure this spec exists to avoid.

## Risks

**The isolate is not actually isolated.** A global the runtime forgot to remove lets the script read the environment or write a file, which skips the capability ceiling. Signal: the isolate test lists the global object and fails when it contains anything other than the four functions, `args`, and the language builtins the spec allows.

**Resume reuses the wrong result.** A hash that omits the schema or the args returns a stale value for a different question. Signal: the resume test changes only the schema and asserts the call reruns.

**A script wedges the parent process.** The isolate shares the process. A tight loop with no `await` never yields. Signal: a run has a wall-clock budget, and exceeding it interrupts the isolate and every child it started. The budget is the session's existing run budget, not a new one.

**Concurrency 4 is wrong.** Four is a guess sized for a dual-core machine. A session that already set `maxConcurrentChildren` keeps its value. Signal: the refusal names the limit, so a user who hits it can raise it. The spec does not pick a default in settings. The runner uses 4 only when the session set nothing.

**Approval fatigue.** A saved script in a trusted project that still asks every time will not get used. The permission rule is the escape, and it is name-scoped. Signal: an unsaved body has no rule key, so it cannot be allowed permanently. The test denies a rule that tries.

## Verification

Tests live in `packages/coding-agent/test/delegation/workflow.test.ts` and use a scratch directory.

- Isolate: `fetch`, `import`, `process`, and `Date.now()` throw, and no child is built.
- One `worker()` of `explore` runs through `runDelegation`. The parent store is unchanged afterward.
- A `general` worker from a plan-mode parent never starts. The tool is denied first.
- A worker type whose tools include `delegate` stops at depth 2 with the existing refusal text.
- Three `parallel` calls on a limit of 2: the third waits, one thrown call is `null`, the other two return.
- Two `pipeline` items that claim the same path refuse. Two that claim different paths each get a worktree, and a clean tree is removed.
- A contradictory schema builds no child. Invalid JSON follow-ups once, then throws.
- Relaunch of an unchanged script starts zero children. Editing call 2 reruns call 2 and call 3 only.
- Deny at the approval prompt starts nothing and writes no artifact directory.
- The workflow tool result's `details.phases` contains each title and the call count under it. Past 25 calls the result carries a warning. The 101st call throws and starts nothing. `apex-code agent list` output is unchanged.
- Saving onto a symlink throws. `/<name>` in an untrusted project asks even when a user rule allows the name, and a denial sends no prompt.

Then `npx tsgo --noEmit` and the existing `packages/coding-agent/test/delegation/` suite. `npm test` once at the end of the last slice, from a scratch cwd.

## Rollout

No new ADR. The authority decision is ADR 0008, and this spec consumes it. The execution plan was deleted on completion. Git keeps it.
