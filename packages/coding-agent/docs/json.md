# JSON Event Stream Mode

```bash
apex-code --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating Apex Code into other tools or custom UIs.

## Event Types

Wire events use `JsonAgentSessionEvent`. It matches
[`AgentSessionEvent`](https://github.com/Fchery87/apex-code/blob/main/packages/coding-agent/src/core/agent-session.ts)
except that streaming message updates omit cumulative snapshots:

```typescript
type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type JsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
  ? WithoutPartial<T> & { id: string; toolName: string }
  : WithoutPartial<T>;

type JsonAgentSessionEvent =
  | Exclude<AgentSessionEvent, { type: "message_update" }>
  | {
      type: "message_update";
      usage: Usage;
      assistantMessageEvent: JsonAssistantMessageEvent<AssistantMessageEvent>;
    };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `compaction_start` and `compaction_end` cover both manual and automatic compaction.

Other base events come from
[`AgentEvent`](https://github.com/Fchery87/apex-code/blob/main/packages/agent/src/types.ts):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base messages from [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/types.ts#L134):
- `UserMessage` (line 134)
- `AssistantMessage` (line 140)
- `ToolResultMessage` (line 152)

Extended messages from [`packages/coding-agent/src/core/messages.ts`](https://github.com/Fchery87/apex-code/blob/main/packages/coding-agent/src/core/messages.ts#L29):
- `BashExecutionMessage` (line 29)
- `CustomMessage` (line 46)
- `BranchSummaryMessage` (line 55)
- `CompactionSummaryMessage` (line 62)

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

`message_update` records are delta-only. They omit both the cumulative `message` field and
`assistantMessageEvent.partial` to keep stream size linear. The top-level `usage` field contains
the latest cumulative provider-reported usage and may remain zero when a provider only reports
usage at completion. Use `contentIndex` and `delta` to assemble live text, thinking, or tool-call
arguments if needed. A `toolcall_start` event also includes the constant-sized `id` and `toolName`
fields. `message_end` contains the final authoritative message.

## Example

```bash
apex-code --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```

## Result envelope and exit codes

A `--mode json` run that reaches a normal terminal outcome ends with a `result` envelope.
It is written by print mode rather than emitted by the session, so it is not an
`AgentSessionEvent` and does not appear in `--mode text`. A run killed by `SIGTERM` or
`SIGHUP` exits from the signal handler before the envelope is written, so a consumer
treats a missing envelope as an incomplete run rather than as a success.

```json
{"type":"result","status":"completed"}
```

`status` is the run's terminal outcome, using the same vocabulary as the agent loop's
`AgentStopReason`:

| `status` | Meaning | Exit code |
| --- | --- | --- |
| `completed` | The run finished normally. | `0` |
| `error` | The run failed, for example a provider error. | `1` |
| `aborted` | The run was cancelled. | `1` |
| `budget-exhausted` | A `runBudget` limit stopped the run. | `1` |

Exit codes are `0` for `completed` and `1` for every other status. A caller that needs to
distinguish the causes reads `status` rather than the exit code, so new statuses can be
added without changing what an existing script sees. Signals are unchanged: `SIGTERM` exits
`143` and `SIGHUP` exits `129`.

Before this envelope existed, a failed `--mode json` run exited `0`, because the exit-code
decision was reachable only from `--mode text`. Scripts written against that behavior treated
every run as a success.

```bash
apex-code --mode json --permission-mode plan --print "Summarize the repository" \
  | jq -r 'select(.type == "result") | .status'
```
