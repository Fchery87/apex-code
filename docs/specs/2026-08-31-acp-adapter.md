# Spec: ACP adapter (`--mode acp`)

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-08-31 |
| Last updated | 2026-08-31 |
| Roadmap phase | none (boundary-gap follow-up; see `docs/research/2026-08-31-harness-landscape.md`) |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility — additive CLI mode (see below) |

**Compatibility posture:** additive. A fourth value joins `Mode`
(`cli/args.ts:12`: `"text" | "json" | "rpc"`); no existing mode, flag, setting,
session-format byte, or prompt-prefix token changes. The ACP surface speaks the
external ACP v1 wire protocol; Apex's own rpc protocol is untouched, so the two
modes coexist without interaction.

## Executive summary

Add `--mode acp`: Apex becomes an Agent Client Protocol v1 agent over stdio
JSON-RPC, which puts it into Zed, the JetBrains IDEs, and every other ACP
client at once — the integration surface the audit found entirely missing.
Strategy is settled (see Current state and Proposed solution): a native,
in-process mode that reuses the in-tree JSONL framing and the existing session
event surface, targeting ACP v1 only, with **no new npm dependency**.

## Context and motivation

- `docs/research/2026-08-31-pi-acp-behavioral-survey.md` — the full evidence
  base: pi-acp (MIT) proves the bridge shape for our direct upstream; ACP v1's
  agent surface is small (initialize, session/new|load, prompt turns,
  session/update notifications, request_permission, cancellation); ACP v2 is
  draft-only; the registry and terminal auth are stabilized.
- `docs/research/2026-08-31-harness-landscape.md` § 2.2 — ACP won the
  editor-integration question (~40-agent registry, JetBrains-native); audit
  recommendation #3.
- `docs/adr/0013-no-unowned-hosted-service-defaults.md` — an in-process stdio
  adapter involves no hosted service; nothing to reconcile.
- `cli/args.ts:12` and `modes/rpc/` — the existing mode plumbing and its
  `jsonl.ts` framing, which ACP's transport matches.

## Current state

- `modes/rpc/jsonl.ts` implements strict newline-delimited JSON framing — the
  same transport shape ACP v1 specifies (JSON-RPC 2.0 over stdio,
  newline-delimited).
- `modes/rpc/rpc-mode.ts` + `rpc-types.ts` run a bidirectional control
  protocol in Apex's own dialect, driven by `--mode rpc`; session events
  (streaming deltas, tool call lifecycle, permission decisions, aborts) are
  already emitted as discrete events there.
- Five capability-keyed permission modes exist
  (`default`, `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk`), and
  `plan_present`, slash commands, skills (`/skill:<name>`), the usage ledger,
  and the session tree are all in-session surfaces today.
- No ACP code exists in the tree (verified by search, 2026-08-31). pi-acp
  (MIT, upstream's adapter) demonstrates the integration end to end for pi.

## The problem

Every ACP client speaks one protocol; Apex speaks only its own. Reaching Zed
or JetBrains means shipping one integration per editor or nothing, while
every peer — including pi, the direct upstream — is reachable through the
registry. The loop is not the gap; the boundary is.

## Goals

- [ ] `--mode acp` speaks ACP v1 over stdio: `initialize` with capability
  negotiation, `session/new`, `session/prompt` turns ending in a `stopReason`
  (`end_turn`, `cancelled` at minimum), and `session/cancel`.
- [ ] Assistant streaming reaches the client as `agent_message_chunk`
  notifications; a turn's tool calls appear as `tool_call` /
  `tool_call_update` with correct `kind` and status lifecycle, and `edit`
  calls carry a `diff` content block with absolute path.
- [ ] Permission asks surface as `session/request_permission` with typed
  options; `allow_always` / `reject_always` persist the same permission rule
  the interactive "always allow" path would, at session scope.
- [ ] Apex's five permission modes are exposed as ACP session modes via
  `session/set_mode` and mode-change updates.
- [ ] `session/load` reattaches to an existing Apex session (the tree's
  selected lineage), backed by the same session manager the CLI uses.
- [ ] Slash commands and skills are advertised via
  `available_commands_update`; a client-invoked command routes through the
  existing command path.
- [ ] Cancellation maps to the session's abort path and always ends in the
  `cancelled` stop reason, never an error response.
- [ ] No `fs/*`, `terminal/*`, or `elicitation/*` client capabilities are
  advertised in v1; `usage_update` is emitted from the existing usage ledger.

## Non-goals

- [ ] **Not a pi-acp dependency or fork — settled.** Pointing pi-acp at
  `apex-code` hands a core integration surface to a third-party package
  hardcoded around the `pi` executable and `~/.pi` paths, and it cannot
  represent Apex-only surfaces (hooks, background shell handles,
  capability-keyed modes). Deriving from it drags its pi-subprocess wrapper we
  do not need. Its *behavior* enters through the research note (ADR 0002);
  running it against a `pi`-named shim as a one-off compatibility probe is a
  manual experiment that executes third-party code and is out of scope until
  someone chooses it deliberately.
- [ ] **No new npm dependency — settled.** The official TypeScript SDK (1.0)
  would buy schema definitions; ACP v1's agent surface is small and pinned
  here plus in schema-shaped tests, and the transport primitives already exist
  in `modes/rpc/jsonl.ts`. The next dependency decision belongs to ADR 0001,
  not this spec.
- [ ] ACP v2. Draft-only; v1 is what Zed and pi-acp speak today. Migration is
  a follow-up axis, tracked, not designed here.
- [ ] `fs/*` and `terminal/*` delegation (Apex executes locally),
  `elicitation/*`, thought streaming, and ACP-side representation of
  delegation (child sessions flatten into the parent's tool-call stream).
- [ ] ACP Registry listing and terminal auth flows (provider auth stays with
  the existing CLI path).

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Mode | `"acp"` joins `Mode`; `--mode acp` starts the ACP server | `cli/args.ts`, `cli/main.ts` |
| Framing | Reuse the strict newline-delimited JSON framing | `modes/rpc/jsonl.ts` (imported, not duplicated) |
| ACP server | JSON-RPC dispatch for `initialize`, `authenticate` (absent → `authMethods: []`), `session/new`, `session/load`, `session/prompt`, `session/set_mode`, `session/cancel`; client-side stubs for `session/request_permission` | `modes/acp/server.ts` (new) |
| Translation | Session events → `session/update` (chunks, tool calls with kinds/locations/diffs from `BashToolDetails`-style details, plan entries, usage); stop reasons; permission responder → typed options; `allow_always` → rule persistence at session scope | `modes/acp/translate.ts` (new) |
| Sessions | One Apex `AgentSession` per ACP session id; `session/load` via the session manager | `modes/acp/server.ts` |
| Commands | `available_commands_update` from the existing slash-command and skill registries | `modes/acp/translate.ts` |

Seam invariants: the ACP mode is a consumer of the same public session surface
the rpc mode uses — no tool, gate, or loop change. Permission decisions flow
through the existing responder path, so `allow_always` persists rules through
the same store and scope the TUI uses (session scope), keeping ADR 0004's
precedence semantics intact. Mode floors still apply: a client-requested mode
switch goes through `session/set_mode` → the same mode store the CLI uses.

## Deletion inventory

Nothing existing is removed — this is additive. The rpc and json modes are
untouched; the only shared file (`cli/args.ts`) gains one union member.

## Risks

- **Protocol drift.** ACP v1 evolves (v2 is in draft). Signal: schema-shaped
  tests that pin the v1 method/update shapes this mode emits, so a drift
  breaks a test, not a Zed session.
- **Double-lineage session semantics.** `session/load` on a branched Apex
  session must pick one lineage deterministically. Signal: a test loading a
  branched session and asserting the selected lineage and continuation.
- **Permission option mismatch.** Apex decisions that are not
  allow/reject-shaped (for example "ask again") must not be silently coerced.
  Signal: translation tests covering every responder outcome.
- **Stdio contention.** ACP owns stdout; anything else writing to stdout in
  this mode corrupts the stream. Signal: the existing stdout-cleanliness test
  extended to `--mode acp`.

## Verification

- Unit tests for translation (events → updates, stop reasons, permission
  options, mode ids) and for the server's method dispatch against a scripted
  in-memory client.
- An end-to-end stdio test: spawn `apex-code --mode acp`, drive
  initialize → session/new → prompt (a scripted read-only turn) → updates →
  `end_turn`, then `session/cancel` mid-turn → `cancelled`.
- Schema-shaped assertions pinning the emitted `session/update` variants.
- Full `npm test` as the closing gate; three-OS CI before landing.

## Rollout

Needs `docs/plans/2026-08-31-acp-adapter.md` — a protocol surface across mode
plumbing, server, translation, and tests, with per-task verification like the
declarative-hooks and background-shell slices. Implementation follows the same
test-first pattern; landing waits on three-OS CI.
