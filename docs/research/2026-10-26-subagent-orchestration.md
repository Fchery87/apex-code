# Research: Subagent orchestration, October 26 2026

**Date:** 2026-10-26
**Status:** Complete
**Question:** Does Apex Code already run subagents, and what did Anthropic's current subagent system add that Apex Code does not have?

This note records behavior. It is not a spec, and it is not permission to copy another project's source, types, or strings. ADR 0002 still applies. Claude Code and the Claude Platform are observed only through public docs and the public changelog.

## Method

Primary sources, fetched 2026-10-26.

- Apex Code `packages/coding-agent/src/core/delegation/` (`agents.ts`, `ceiling.ts`, `runtime.ts`) and `packages/coding-agent/src/core/tools/delegate.ts`. The delegation spec is `docs/specs/2026-08-14-delegation-and-multi-agent.md`, status Landed. The roadmap marks Phase 5 landed at `be00e1ab0`.
- Claude Code docs index, [Run agents in parallel](https://code.claude.com/docs/en/agents), [Create custom subagents](https://code.claude.com/docs/en/sub-agents), and [Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows).
- Claude Code changelog, `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md`, newest heading **2.1.311, October 26, 2026**.
- Claude Platform docs, [Multiagent orchestration](https://platform.claude.com/docs/en/managed-agents/multi-agent).

No Anthropic newsroom post dated October 26, 2026 announces a subagent system. The October 26 changelog entry is maintenance: runner hold flags, VS Code coloring, and an `ultrathink` effort change. The system the current docs describe shipped earlier and is still being revised in that changelog.

## What shipped, and when

| Surface | First public appearance found | What it is |
| --- | --- | --- |
| Custom subagents | Older than this survey. The live page is the current contract | A markdown file with frontmatter. Its own context, prompt, tools, model, and permission mode. Returns a summary |
| Dynamic workflows | Claude Code **2.1.154**, "Introducing dynamic workflows" | A JavaScript script the model writes. A runtime runs it and calls subagents. `/workflows` shows the run |
| `multiagent_20261001` | The type name dates the API shape to 2026-10-01. The 2.1.309 changelog (October 22, 2026) says the `/claude-api` skill now builds Managed Agents teams on this type "with dynamic workflows on by default, instead of `coordinator`" | The hosted version of the same three moves: delegate, run a workflow, consult an advisor |

The trigger word was renamed from `workflow` to `ultracode` after 2.1.154. Asking in ordinary words still starts a run. `ultracode` as an `/effort` toggle no longer forces xhigh effort.

## Apex Code already has subagents

`delegate` executes. It is not the example extension under `examples/extensions/subagent/`, which still spawns a fresh CLI and is not on the production path.

A call names `agentType` and `task`. The runtime resolves a definition, refuses an unknown type, refuses a call at `maxDelegationDepth` by name, and refuses a requested capability the parent does not hold by name (`resolveAdmittedDefinition` in `runtime.ts`). The child is an in-process session. Its permission store is derived. Its writes do not widen the parent. ADR 0008 is why: reconstructing authority in a subprocess cannot carry the runtime-only permission sources.

Built-in types are `explore` (read, grep, find, ls), `debugger` (those plus bash), `verifier` (those plus test), and `general` (read, bash, edit, write, grep, find, ls). `general` does not include `delegate`. User definitions live under the agent dir's `agents/`. Project definitions load only when the project is trusted. A user or trusted-project file with the same name replaces the built-in. Definitions are re-read on the next delegation.

Background work returns a handle. Retrieval waits if the child is still running. `apex-code agent list|wait|send|resume|interrupt|close` reports those runs through `session.listChildRuns()`. The interactive `/tasks` command is unrelated: it toggles the `todo_write` panel. The registry caps concurrent children when `maxConcurrentChildren` is set, dedupes a repeated spawn by `idempotencyKey`, and can reopen a child session after restart. `workspace.isolation: "worktree"` uses `GitWorktreeWorkspaceOwner`. Overlapping write claims are refused.

The tool description lists known types, capped at 1,500 characters. `delegate` stays `deferSchema: true` and `ask` by default. Permission rules match `agentType` with a glob, so `explore:*` still means what it meant before Phase 5.

## How the current Claude Code system is shaped

The [agents page](https://code.claude.com/docs/en/agents) lists five ways to run work at once. Three of them are coordination styles. Two are places the work runs.

| Approach | Who holds the plan | Workers talk to each other? | Apex Code today |
| --- | --- | --- | --- |
| Subagent | The parent, one turn at a time | No. The child returns a result | `delegate` |
| Agent team | A lead session, one turn at a time | Yes. Shared task list | No. The 2026-08-14 spec lists inter-agent messaging as a non-goal |
| Dynamic workflow | A script, not the model | No. Results are script values | No |
| Agent view | The user | Only if the user turns on cross-session messaging | No, and not needed for this gap |
| Projects | A hosted conversation over days | Threads report to the user | Declined. ADR 0013 forbids a default dependency on a hosted service Apex Code does not run |

The subagent file is still the worker. The workflow does not replace it. A workflow script has no filesystem and no shell. It calls `agent()`, `pipeline()`, and `parallel()`, groups them with `phase()`, and prints with `log()`. `args` is the only input. `Date.now()`, `Math.random()`, and `new Date()` throw, so a relaunch repeats the same calls. `import()` is rejected. A saved script is `export const meta` plus that body.

The limits on the live workflows page, read 2026-10-26:

- 16 concurrent agents by default, lower when fewer CPUs are visible, overridable from 1 to 256 (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`, since v2.1.269).
- 4,096 items in one `parallel()` or `pipeline()`.
- 1,000 agents in one run.
- A warning, not a stop, above 25 agents or a projected 1.5 million tokens. Pro defaults the size guideline to small.

Resume is the part worth copying as behavior. Completed `agent()` calls return their saved result. The first call whose prompt changed, and every call after it, runs again. A failed call runs again, and so does everything the script starts after it. The script stores nothing on disk itself. The runtime stores each call's result.

Structured output is the other part. `agent(prompt, { schema })` returns JSON. A schema the runtime can prove contradictory fails before the child starts. Output that still fails validation after five tries fails the call. Inside `parallel()` or `pipeline()`, a stopped or unrecoverable call becomes `null` and the run continues.

The Managed Agents page is the same design on a server. `multiagent_20261001` enables `subagents` and `workflows` by default and leaves `advisor` off. Delegation is one level. A session may have 25 child threads. A predefined-agent list holds at most 20. Inline agents are on unless disabled. An advisor is a model the primary thread consults mid-turn. It is not a subagent, and a failed consultation does not fail the turn. Workflow-run threads are not follow-up targets. Subagent threads are.

## What not to copy

- Agent teams. The 2026-10-22 gap note already declined them. `delegate` plus a worktree covers the job, and the Claude Code page still marks teams experimental and off by default.
- A plugin marketplace, org-managed agent policy, and the `/agents` library UI. Distribution, not a missing coding capability.
- Hosted Projects, Remote Control, and cloud routines. ADR 0013.
- The advisor as a default. It spends a second model's tokens on every consultation and, on current Opus, the client may only see a redacted placeholder. Apex Code can route a child to a named model already. A mid-turn advisor is a separate product decision.
- `ultracode` as a mode that starts a workflow for every substantive task. The workflows page says this spends the limit faster. Opt-in per prompt is enough.
- Any of Claude Code's prompt text, frontmatter field names, or script API names. The behavior is the source. The names are theirs.

## The gap that is worth closing

Apex Code can run a child and can run it in the background. It cannot hold a plan outside the parent's context. A fan-out of N children is N tool results in the parent transcript. The parent then has to remember which result belonged to which file. That is the failure dynamic workflows exist to avoid: the orchestrator is a context window.

The child runtime is already the worker. A workflow should be a new tool that calls `runDelegation`, not a second way to construct a child.
