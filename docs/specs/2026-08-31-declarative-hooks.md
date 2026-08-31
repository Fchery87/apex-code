# Spec: Declarative hooks over the extension event catalog

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-08-31 |
| Last updated | 2026-08-31 |
| Roadmap phase | none (boundary-gap follow-up; see `docs/research/2026-08-31-harness-landscape.md`) |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility — additive settings key (see below) |

**Compatibility posture:** this is additive and preserves compatibility. A
`hooks` key joins the settings schema; an absent key constructs nothing, the
established posture of `checkpoints` and `lsp` (`settings-manager.ts:206-210`).
The prompt prefix is untouched — hooks never enter it — so the byte-identical
prefix property that governs conditional tool registration is not in play. No
existing config, session format, or CLI flag changes.

## Executive summary

Expose the extension event catalog through a `hooks` key in settings, so an
operator can run a shell command or HTTP call at lifecycle points without
authoring a TypeScript extension. Version one maps five events (`tool_call`,
`tool_result`, `session_start`, `turn_end`, `session_before_compact`) onto two
handler kinds (command, HTTP), with block/allow/ask decisions only where a
decision is meaningful (`tool_call`). The hard part — 36 typed, blocking,
mutable events — already exists; this adds the cheap path onto it.

## Context and motivation

- `docs/research/2026-08-31-harness-landscape.md` § 2.1 — config-file hooks
  are now how organizations constrain agents they did not write; peers ship
  them as a category norm. § 2.1 is also the behavioral reference for handler
  and exit-code semantics (ADR 0002 channel).
- `docs/adr/0004-permission-rule-model.md` — rule resolution stays the
  authority; hooks sit beside it, never replace it.
- `docs/architecture/overview.md` — `beforeToolCall` is *the* permission seam;
  "nothing may execute a tool by another path." A hooks bridge must ride the
  existing seam.
- `docs/adr/0010-one-canonical-tool-contract.md` — hooks intercept; they do
  not describe tools, so no second projection of the registry is created.
- `docs/adr/0016-trust-first-supervisor-policy.md` — the trust posture this
  design extends (see Proposed solution).

## Current state

- `extensions/types.ts:1255-1294` declares the listener catalog: 36 overloads
  including `tool_call` (blocking, input-mutating), `tool_result`
  (result-rewriting), `session_start`, `turn_start`, `turn_end`,
  `before_agent_start`, `session_before_compact`, `context`, `user_bash`.
- `agent-session.ts:568-624` (`_installAgentToolHooks`) fixes the order:
  extension `tool_call` handlers fire first and may block or mutate; the
  permission gate then evaluates the final arguments; execution follows; in
  `afterToolCall`, evidence is captured and contract-checked, then extension
  `tool_result` handlers may rewrite, then image normalization runs last.
- The settings schema has no `hooks` key. Reaching any event means authoring a
  TypeScript extension module and having a JS toolchain in the environment.
- Precedents for scope discipline: project-scope `sandboxProfiles` is ignored
  by policy (`settings-manager.ts:196-201`, ADR 0016), while project-scope
  agent definitions in `.apex-code/agents` load only after the project-trust
  decision (`core/delegation/agents.ts`).

## The problem

The capability exists and is good, but the ordinary uses are unreachable
without a plugin: run the formatter after an edit, refuse a commit to main,
post to a webhook when a turn ends, gate a tool in CI where nobody ships an
extension. Peers expose the same events through a settings file; an operator
who will never write a TypeScript module can govern Claude Code today and
cannot govern Apex Code.

## Goals

- [ ] A `hooks` key in the settings schema validates and loads handlers for
  `tool_call`, `tool_result`, `session_start`, `turn_end`, and
  `session_before_compact`; malformed hook config fails closed (rejected at
  load) the way malformed permission rules are.
- [ ] A command handler receives the event payload as JSON on stdin and may
  return a decision as JSON on stdout; exit 0 with no output means "no
  decision."
- [ ] A hook can block a tool call, and the block flows through the existing
  `beforeToolCall` seam — no second execution path exists.
- [ ] The permission gate still evaluates the post-hook arguments; the gate
  remains the last check before execution, and an `allow` decision from a
  hook cannot bypass it.
- [ ] Project-scope hooks do not load before the project-trust decision;
  global-scope hooks load unconditionally.
- [ ] With no `hooks` key, session behavior is unchanged: no new subprocesses,
  no prompt change.
- [ ] Spawn failure or timeout of a `tool_call` hook blocks the call (fail
  closed), consistent with the gate's ask-with-no-responder behavior.
- [ ] Command handlers run on Windows through PowerShell without a bash
  dependency.

## Non-goals

- [ ] The other 31 events. Five cover the motivating uses; the mapping is
    additive per release, and every event added later reuses the same bridge.
- [ ] Hook input mutation. Extensions keep that power; shell handlers are
    read-only observers with a block/allow/ask decision. Mutation-by-stdin-JSON
    is where config-file hooks become an injection surface.
- [ ] Regex matchers. V1 matchers are tool-name exact or `|` lists, mirroring
    permission-rule matching; grammar creep is deferred.
- [ ] Prompt and agent handler types — they put model calls inside a hook,
    which is a new failure class (recursion, cost, latency), not a config
    file.
- [ ] Async/background handlers — they strain "the agent loop settles"
    (`docs/architecture/overview.md`, inherited invariants).
- [ ] MCP-tool handlers, env-var interpolation into handler headers, and
    exposing Apex Code as an MCP server or ACP agent (separate specs).

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Settings schema | `hooks?: Partial<Record<HookEventName, HookHandlerConfig[]>>`, where `HookHandlerConfig` is `{ type: "command" \| "http"; matcher?: string; command?: string; url?: string; timeoutMs?: number }` | `core/settings-manager.ts` |
| Loader | Parse + validate per scope; project-scope entries held until project trust grants the project; produce an immutable handler list | `core/hooks/loader.ts` (new) |
| Bridge | Feed declarative handlers into the existing emission points: `tool_call` handlers run after extension handlers and before the gate; `tool_result`/lifecycle handlers run after extension handlers at their existing points; no decision is read from non-`tool_call` events in v1 | `core/agent-session.ts` (extend `_installAgentToolHooks` call sites) |
| Command runner | Spawn via platform shell (`sh -c`, PowerShell on Windows), event JSON on stdin, 10s default timeout, decision JSON on stdout | `core/hooks/command-handler.ts` (new) |
| HTTP runner | POST event JSON, read JSON decision from the 200 response, same timeout; URL only from settings, no env interpolation | `core/hooks/http-handler.ts` (new) |

Decision semantics for `tool_call` only: `{ "decision": "allow" \| "block" \|
"ask", "reason?": string }`, and the vocabulary is restriction-only: `block`
short-circuits with the reason, `ask` defers to the permission gate and its
responder, and `allow` is recorded but never bypasses the gate. Exit-code
table for command handlers, mirroring the behavior described in
`docs/research/2026-08-31-harness-landscape.md` § 2.1: exit 0 + JSON = that
decision; exit 0 + no output = no decision; exit 2 = block with stderr as
reason; any other nonzero = warning, no decision.

Seam invariant: the bridge adds handlers at the existing emission points; the
gate remains the last check before execution and evaluates final arguments
(`agent-session.ts:592-620`). Hook firings are not evidence and emit no
evidence kinds; a blocking decision is recorded as a transcript system note,
not into the ledger.

Trust posture (settled 2026-08-31): project-scope hooks load only after the
project-trust decision, exactly like project extensions and
`.apex-code/agents`; global-scope hooks load unconditionally. The deciding
principle is that hooks are restriction-only: because `allow` cannot bypass
the gate and no handler mutates input, a hook can only narrow what runs,
never widen it. That is what separates hooks from `sandboxProfiles`, which
ADR 0016 rightly confines to global scope — a profile relocates the OS
boundary itself, so a project-supplied one is privilege escalation, while a
project-supplied hook adds a check inside the existing boundary. A malicious
*trusted* project gains nothing through hooks that its extensions cannot
already do, so the extension trust posture costs nothing in safety and keeps
the org-policy use case (repo-committed, team-shared hooks) that a
global-only rule would kill.

Delegation children do not inherit the parent's hook runtime — the
`checkpointSettings` posture in `createAgentSession`. Whether child sessions
should fire hooks at all is deferred until the double-fire question (a child
and its parent both matching the same handler) and the authority question
(whose trust state governs a child spawned mid-turn) are settled.

## Deletion inventory

Nothing existing is removed — this is additive. The extension API remains the
power path (blocking, mutating, typed), declarative hooks are sugar over the
same events, and no code path, config key, or document is superseded.

## Risks

- **Untrusted project config as an attack vector.** A repo-committed hooks key
  is untrusted input until the trust decision, the same way `.apex-code/agents`
  is; project-scope handlers do not fire in an untrusted project. Signal: a
  test asserting exactly that. Residual risk after trust is accepted: a
  malicious trusted-project hook can block calls (denial of service) and
  observes event payloads, but it cannot widen authority (restriction-only
  decisions), and a trusted project's extensions already hold strictly
  greater power — the exposure delta is nil.
- **Per-tool-call latency.** A slow handler delays every matching tool call.
  Signal: the default 10s timeout in tests; matchers mean unconfigured tools
  spawn nothing.
- **Recursion.** A hook that invokes Apex Code can recurse. V1 documents
  rather than prevents this; if field reports show it, a depth guard is a
  small follow-up.
- **Malformed handler output.** Non-JSON stdout is treated as "no decision"
  plus a warning, never as allow.

## Verification

- New vitest suite for the loader (validation, scope/trust holding, fail
  closed on malformed config), the bridge (ordering: extensions → hooks →
  gate; no decision read from non-`tool_call` events), and the command runner
  (full exit-code table, timeout fail-closed, no-decision passthrough).
- Prompt-prefix test: an absent `hooks` key leaves the static prefix
  byte-identical, reusing the pattern that covers conditional `lsp`/`mcp`
  registration.
- Manual check recorded in the plan: a `PreToolUse`-style hook that blocks
  `bash` commands matching `git push` on a scratch session.

## Rollout

Small enough to implement directly — one settings key, one loader, one bridge,
two runners — so no separate plan doc. The trust posture is settled (see
Proposed solution); no ADR is required because the decision applies ADR 0016's
existing rule to a new extension source rather than setting new policy. If
implementation ever surfaces a genuine conflict with that rule, write the ADR
then and cite it from here.
