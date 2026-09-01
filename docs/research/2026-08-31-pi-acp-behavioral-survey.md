# Research: pi-acp and the ACP adapter surface

**Date:** 2026-08-31 · **Status:** Permanent — source of record for the ACP adapter design inputs

> **Provenance.** `pi-acp` is MIT-licensed (LICENSE verified verbatim,
> Copyright (c) 2025 Sergii Kozak — SPDX: MIT), so reading it is legally clear;
> per this repository's convention the record below is still behavioral, cited
> to its README (retrieved 2026-08-31) rather than transcribed from source. ACP
> protocol behavior is cited to the official v1 protocol pages at
> agentclientprotocol.com (retrieved 2026-08-31). No unlicensed material is
> involved (ADR 0002). Specs cite this file.

## 1. Why this exists

The audit's #3 recommendation is an ACP adapter over the existing rpc mode
(`docs/research/2026-08-31-harness-landscape.md` § 5). The direct upstream
already has one: `svkozak/pi-acp`, listed in the ACP registry and on
zed.dev/acp/agent/pi. This note records what it does, what ACP v1 actually
requires, and what that implies for an Apex adapter — so the adapter spec
starts from evidence instead of a blank page.

## 2. What pi-acp is

A bridge, not a harness: it speaks **ACP JSON-RPC 2.0 over stdio** to the
client (Zed), and **spawns `pi --mode rpc` as a subprocess**, translating
between the two protocols. Layout: `src/acp/*` (ACP server + translation
layer) and `src/pi-rpc/*` (pi subprocess wrapper). npm package `pi-acp`,
v0.0.33 (2026-07-30), 144 commits, active with 10 contributors.

Behavioral highlights (README, retrieved 2026-08-31):

- Assistant output streams as ACP `agent_message_chunk`; no separate thought
  stream.
- Tool execution maps to ACP `tool_call` / `tool_call_update`. It resolves
  relative file paths against the session cwd before emitting **locations**
  (path + optional line, enabling Zed follow-along), infers a 1-based line
  number for edits from a unique `oldText` match against a pre-edit snapshot,
  and emits a **structured diff** (`oldText`/`newText`) on edit completion.
- Session persistence: a sidecar map (`~/.pi/pi-acp/session-map.json`) links
  ACP session ids to pi session files so `session/load` can reattach; sessions
  resume in both the client and pi.
- Slash commands: file-based prompts plus built-ins (`/compact`,
  `/autocompact`, `/export`, `/session`, `/steering`, `/follow-up`), and
  skills surfacing as `/skill:<name>`. Extension-provided commands are not
  supported.
- Registry support via **terminal auth**: the agent advertises `authMethods`,
  and the client shows an Authenticate banner that runs `pi-acp
  --terminal-login`.
- An opt-in `embeddedContext` prompt capability.

Stated limitations: no `fs/*` or `terminal/*` delegation (pi reads, writes, and
executes locally); MCP servers in ACP params are stored but not wired through;
queueing is client-side; self-described as an MVP centered on Zed.

## 3. What ACP v1 requires (agent side)

From the official v1 pages (overview, prompt-turn, tool-calls; retrieved
2026-08-31):

- **Transport and shape**: JSON-RPC 2.0 over stdio; methods and notifications;
  camelCase keys, snake_case discriminators; all file paths absolute; line
  numbers 1-based.
- **Lifecycle**: `initialize` (version/capability negotiation, `authMethods`)
  → optional `authenticate`/`logout` → `session/new` or `session/load`
  (requires the `loadSession` capability) → `session/prompt` turns.
- **A turn**: `session/prompt` (content blocks: text, images, resources) →
  `session/update` notifications (`agent_message_chunk` with optional
  grouping `messageId`, `user_message_chunk`, thought chunks, `plan`,
  `tool_call` / `tool_call_update`, `available_commands_update`, mode changes,
  `usage_update` with used/size/optional cost) → the `session/prompt`
  **response** carries a `stopReason`: `end_turn`, `max_tokens`,
  `max_turn_requests`, `refusal`, `cancelled`.
- **Permissions are a client-side method**: the agent calls
  `session/request_permission` with typed options (`allow_once`,
  `allow_always`, `reject_once`, `reject_always`) and the client answers
  `selected` (with `optionId`) or `cancelled`. On `session/cancel`, pending
  permission requests MUST be answered `cancelled` and the agent MUST end the
  turn with the `cancelled` stop reason — cancellations are not errors.
- **Tool calls**: `toolCallId`, human title, `kind` (`read`, `edit`, `delete`,
  `move`, `search`, `execute`, `think`, `fetch`, `other`), status lifecycle
  `pending → in_progress → completed | failed`, content blocks (text, images,
  `diff` with absolute path and `oldText`/`newText`, terminal reference),
  `locations` (path + line), and optional `rawInput`/`rawOutput`.
- **Client-side optional capabilities** the agent may invoke: `fs/*` reads and
  writes, `terminal/*` create/output/wait/kill/release, `elicitation/create`.
  An agent that executes locally (like pi, like Apex) simply does not advertise
  them — pi-acp's most important limitation is exactly this, and it is fine.
- **Modes and commands**: `session/set_mode` plus mode-change updates;
  `available_commands_update` advertising slash commands.
- **Ecosystem state**: ACP v2 is published in draft (new prompt lifecycle,
  permission-request RFD, message updates); the official **TypeScript SDK is
  at 1.0**; the Registry and terminal auth are stabilized.

## 4. What this implies for an Apex adapter

- **The bridge shape is proven for our exact lineage**: pi-acp exists because
  pi's rpc mode already carries the semantics ACP needs. Apex forked that rpc
  mode and the audit independently concluded Apex's rpc mode "already carries
  the semantics ACP needs." The adapter question is protocol translation, not
  harness work.
- **Three implementation strategies are on the table**, for the spec to decide:
  (a) evaluate `pi-acp` as-is pointed at the `apex-code` binary — it spawns
  `pi --mode rpc`, and Apex's rpc mode descends from the same v0.84 lineage;
  wire compatibility is plausible but unverified; (b) write an Apex adapter
  modeled on pi-acp's bridge shape (MIT permits derivation with attribution);
  (c) implement ACP natively in-process as a new mode, using the official
  TypeScript SDK (1.0) or hand-rolled JSON-RPC. Each has different upstream-
  drift and dependency implications (ADR 0001/0003).
- **Permission mapping is unusually clean**: Apex's ask/allow/deny with
  "always" persisting a permission rule maps onto `allow_always` /
  `reject_always` (what rule source and scope a client-side "always" writes is
  a spec decision with ADR 0004 consequences). Apex's five capability-keyed
  modes map onto ACP session modes via `session/set_mode`.
- **Known v1 boundaries to carry over**: no `fs/*` or `terminal/*` delegation
  (Apex executes locally; our background-shell handles live in-process, and
  ACP terminal surfaces are a candidate follow-up, not a v1 dependency); no
  separate thought stream unless Apex emits one; delegation (subagents) has no
  ACP representation — a child session's tool calls would flatten into the
  parent's tool-call stream unless deliberately surfaced.
- **Target ACP v1**, not the v2 draft: v1 is what Zed and pi-acp speak today;
  the official TS SDK 1.0 targets the stabilized surface. Track v2 in the spec
  as a follow-up axis.

## 5. What this feeds

`docs/specs/<date>-acp-adapter.md` — the adapter spec, covering: strategy
choice from § 4, the permission/mode mapping, session lifecycle (including
`session/load` against Apex's session tree), command advertisement, and the
tests that prove an ACP client can drive a real Apex turn.
