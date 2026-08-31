# Research: agentic-harness landscape, August 2026

**Date:** 2026-08-31 · **Status:** Permanent — source of record for the boundary-gap design inputs

> **Provenance.** External observations below are behavioral descriptions from
> public vendor documentation, cited inline with retrieval dates. No unlicensed
> source is involved (ADR 0002). Apex-side counts were measured directly from
> this tree at `e525bae18` on 2026-08-31. A third-party audit artifact
> (claude.ai, user-generated, unverified) prompted this note; every load-bearing
> claim was re-verified before being recorded here, and corrections are in
> § 4. Specs and ADRs cite this file, not the artifact.

## 1. Why this exists

An external audit ("Apex Code Harness Audit", retrieved 2026-08-31) concluded
that the loop is ahead of the field while the integration boundary is behind:
config-file hooks, a standard editor protocol, background shell execution, and
remote MCP auth. This note records the verified external facts and the measured
Apex state that the boundary specs cite. The highest-leverage gap per the audit
is declarative hooks over the existing extension events; that spec
(`docs/specs/2026-08-31-declarative-hooks.md`) is written against § 2.1.

## 2. What moved in the field

### 2.1 Config-file hooks became the category's governance layer

- **Claude Code** exposes exactly 33 hook events with five handler types —
  command, HTTP, MCP tool, prompt, and agent — configured in settings files
  (user, project, local, managed policy, plugins, skills, subagent
  frontmatter). Counted from the official hooks reference
  (https://code.claude.com/docs/en/hooks, retrieved 2026-08-31). Behavioral
  facts relevant to our design: command handlers receive the event payload as
  JSON on stdin and return a JSON decision on stdout; `PreToolUse` can block a
  tool call with a reason; exit 0 with no output means "no decision"; hooks
  merge across settings levels; managed policy can restrict sessions to
  managed hooks (`allowManagedHooksOnly`); hooks fire inside subagents with
  `agent_id`/`agent_type` on the input; and settings-file hooks are held back
  until the workspace-trust decision (or always trusted in `-p`/SDK mode).
- **Codex CLI** ships a hooks engine behind `[features].codex_hooks`
  (audit-reported; Interrupt event reached in v0.150.0 on 2026-08-26 — not
  independently verified).
- **opencode** has a JS plugin system hooking 25+ lifecycle events, and
  **Amp** ships hooks (both audit-reported, not independently verified).

### 2.2 ACP settled the editor-integration question

- The Agent Client Protocol (created by Zed, August 2025) has an official
  agent registry, launched January 2026 (zed.dev/blog/acp-registry,
  2026-01-28; JetBrains blog, 2026-01-31) and integrated directly into
  JetBrains IDEs. The registry lists roughly 40 agents
  (agentclientprotocol.com/get-started/agents, retrieved 2026-08-31),
  including Claude Code, Codex CLI, Gemini CLI, Copilot, Cursor, Goose,
  Cline, opencode — and Pi.
- **Prior art one fork away:** Pi's registry entry is served by a third-party
  adapter, `svkozak/pi-acp` (GitHub, 2026-07), also listed at
  https://zed.dev/acp/agent/pi. An Apex ACP adapter starts from a behavioral
  survey of that adapter. Check its license before reading code for porting;
  behavior enters through this note (ADR 0002).
- Unverified audit detail: ACP as the "headline feature of Zed 1.0, April
  2026."

## 3. Measured Apex state (2026-08-31, `e525bae18`)

- 17 built-in tools registered by default; `lsp` and `mcp` register only when
  configured, keeping the static prompt prefix byte-identical
  (`core/tools/index.ts`).
- Deferred schemas announce **10 built-ins plus the MCP proxy** — 11 total.
- Extension listener overloads: **36** in `extensions/types.ts:1255-1294`,
  including `tool_call` (blocking, input-mutating), `tool_result`
  (result-rewriting), `session_start`, `turn_start`, `turn_end`,
  `before_agent_start`, `session_before_compact`, `context`, `user_bash`.
- Permission modes: five, capability-keyed (`default`, `plan`, `acceptEdits`,
  `bypassPermissions`, `dontAsk`).
- `AgentHarness`: **22** methods reject with `HarnessNotImplemented`; its
  `hooks`/`events` registries throw on `.on()`.
- Subsystems an earlier draft of this survey missed:
  `packages/server` + `packages/protocol` + `packages/client` (embeddable
  transport layer), `core/lsp/` beyond the tool, the project trust manager,
  and `core/compaction/`.
- Verified defects (found 2026-08-31, fixed in the working tree the same
  day): `npm test` aborted at the SBOM script test with `ESBOMPROBLEMS` when
  `node_modules` lagged the lockfile, with nothing indicating `npm install`
  was the remedy; `delegate.ts` and `delegation/runtime.ts` still described
  landed Phase 5 delegation work as unwired.

## 4. Corrections to the audit artifact

| Claim | Artifact said | Measured |
| --- | --- | --- |
| Deferred built-in schemas | 11 + MCP proxy | 10 + MCP proxy (11 total) |
| Extension events | 32 | 36 listener overloads |
| `HarnessNotImplemented` methods | ~20 | 22 |
| Batch-boundary compaction | `agent-session.ts:497` | install site is :497; threshold check ~:2500 |
| MCP construction gating | "unless a settings key is present" | MCP has no settings key; `.mcp.json` gates it |
| ACP registry size | 25+ agents | ~40 agents |

## 5. What this feeds

- `docs/specs/2026-08-31-declarative-hooks.md` — § 2.1 is the behavioral
  reference for handler and decision semantics.
- A future ACP adapter — after a behavioral survey of `pi-acp` (§ 2.2).
- Background shell, MCP OAuth re-take, checkpoint defaults, and the
  `AgentHarness` keep-or-delete ADR — in the audit's priority order.
