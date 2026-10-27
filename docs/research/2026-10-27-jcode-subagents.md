# Research: jcode subagents, October 27 2026

**Date:** 2026-10-27
**Status:** Complete
**Question:** What are the subagents in jcode, and how do they differ from Apex Code's?

This note records behavior read from source. It is not a spec, and it is not permission to copy jcode's types, names, or prompt text.

## Method

Primary sources, read 2026-10-27.

- jcode `https://github.com/1jehuang/jcode` at `30b4511` (2026-10-26, "Pin native handoff to hosted rust-src provisioning fix"), checked out under scratch, not vendored.
- `crates/jcode-app-core/src/tool/mod.rs`, `tool/communicate.rs`, `tool/tests.rs`, `crates/jcode-tool-types/src/lib.rs`.
- `crates/jcode-app-core/src/server/comm_session.rs` (`spawn_swarm_agent`, the root-only gate) and `server/swarm.rs` (`run_swarm_task`, `run_swarm_message`).
- `crates/jcode-tui/src/tui/app/commands.rs` (`/subagent`) and `docs/SWARM_ARCHITECTURE.md`.
- Apex Code `packages/coding-agent/src/core/tools/delegate.ts`, `core/delegation/agents.ts`, `ceiling.ts`, `workflow-run.ts`, and ADR 0008.

## What jcode has

The direct subagent tool is gone. `subagent_tool_is_not_registered` in `tool/tests.rs` asserts the registry does not expose it, and its failure text says to use swarm instead. `resolve_tool_name` still maps `task`, `task_runner`, and `Agent` to `subagent`. Nothing registers a tool under that name. `Registry::execute` then returns `Unknown tool: subagent` and lists the registered tools. The suggestion pass does not offer `swarm`: the names share no prefix and the edit distance is past its threshold. `/subagent` and `handle_run_subagent` both build that call, so both end at the same error.

`/subagent` is a user command. It takes a prompt, `--type` (default `general`), `--model`, and `--continue <session id>`, then builds a tool call named `subagent` and runs it through the registry. With the tool unregistered, that call does not start a child. `/subagent-model` still pins the model later children inherit.

`swarm` is the live system. The tool is `CommunicateTool`, registered as `swarm`. The old name `communicate` resolves to it. Advertised actions are `launch`, `spawn`, `message`, `status`, `plan_status`, `list`, `summary`, `await_members`, `stop`, `resume`, `retry`, `list_models`, and `list_swarms`. Older plan and task actions still execute for old transcripts. They are not offered to the model.

`spawn_swarm_agent` creates a real session:

- Only the root session may spawn. A worker that tries is told recursive spawning is disabled and is given the root session id.
- The hard cap is 1000 live members. A lower configurable live-worker budget applies first.
- A worker is a visible window or a headless in-process session. It keeps the coordinator's auth route and model unless the spawn names a model.
- Workers message each other. Direct messages are the preferred channel. Channels and shared context exist and are discouraged. Cross-swarm traffic is direct messages only.
- One shared plan per swarm, owned by the root coordinator. Each worker owns a todo lane. A finished turn pushes a bounded output tail back to its owner.
- There is no typed agent catalog on this path. `subagent_type` appears in `run_swarm_message`, which debug commands call. There it is a label in the session title, and the child receives every tool the parent has except `subagent`, `task`, and the todo tools.

## How Apex Code differs

Apex kept the single-shot child and added a script runner. It did not build a team.

| | Apex Code | jcode |
| --- | --- | --- |
| One child, one task | `delegate`. Names `agentType` and `task`. Returns the output, or a handle when `background` is set | Removed. `/subagent` calls the missing tool |
| Built-in kinds | `explore`, `debugger`, `verifier`, `general`. `general` does not include `delegate` | None. A worker is a full session |
| Custom kinds | Markdown under the user `agents/` dir. Project definitions load only when the project is trusted | None |
| Authority | In-process, derived. The ceiling refuses a capability the parent lacks by name. Child approvals do not widen the parent (ADR 0008) | A new session on the same server. No capability ceiling. The live spawn path does not narrow the tool set |
| Depth | `maxDelegationDepth` | One level, because workers cannot spawn. No numeric depth cap in production |
| Fan-out | `workflow`. A script calls `worker()`, `parallel()`, `pipeline()`, and `phase()`. Stops at 100 calls. Warns past 25. Children do not talk | `swarm` `launch` and `spawn`. Children do talk |
| Plan | The script holds it. Phase counts are on the tool result | A server-side plan per swarm, plus per-worker todo lanes |
| Inspection | `apex-code agent list`, `wait`, `send`, `resume`, `interrupt`, `close` | `swarm` `list`, `status`, `summary`, `message`, `stop`, `resume`, `retry` |
| Isolation | Optional git worktree per child. Overlapping write claims are refused | Optional worktrees. Many agents may share one |

## What not to copy

- The swarm itself. The 2026-08-14 delegation spec lists inter-agent messaging and a shared task list as a non-goal. jcode is that system, and it is the one they kept after deleting the single-shot tool.
- Tool-name aliases that point at an unregistered tool. `task` resolving to `subagent` while `subagent` is absent means a model trained on the old name fails instead of being redirected.
- `run_swarm_message`. It asks the parent model to emit a JSON plan and then runs each item. That puts the plan back in a context window, which is the failure a workflow script exists to avoid.
- Any of jcode's action names, session title format, or swarm prompt text.

## What Apex already has that jcode does not

A typed, permission-bounded child, and a workflow script whose plan runs outside the parent's context, with deterministic replay, a schema on each worker result, and a hard call cap. jcode's equivalent of the script is the coordinator model holding the plan and assigning lanes.
