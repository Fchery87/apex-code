# Spec: Native MCP support

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | fchery87 |
| Created | 2026-08-28 |
| Last updated | 2026-08-28 |
| Roadmap phase | Product-surface follow-up (post Phase 12) |
| Tracking issue/PR | none |
| Compatibility posture | **Preserves compatibility.** Additive in full. Apex Code has no MCP support today, so no caller, config file, or session can break. The change adds one tool name (`mcp`), one optional config file (`.mcp.json`), and one cache directory. A session with no MCP server configured builds no MCP runtime and registers no `mcp` tool at all, so `getAllTools()`, the default tool set, and the static prompt prefix are byte-identical to today. A clean break was never available, because there is nothing to break. |

## Executive summary

Apex Code gains MCP server support through a single `mcp` proxy tool rather than by registering every server tool individually. Tool metadata caches to disk, so search and listing answer without a running server, and servers connect on first real call and disconnect when idle. Every MCP tool resolves a declared tool contract instead of falling into `UNCLASSIFIED`, which is the part no third-party adapter can supply and the reason this is built rather than adopted.

## Context and motivation

- `docs/research/2026-08-28-pi-extension-references-mcp-and-questions.md` is the investigation this acts on. It measures `pi-mcp-adapter` at 25,627 lines of non-test source, identifies a 6,466-line core and an 8,444-line set deferred here, and records why the contract gap makes adoption the wrong shape.
- `docs/adr/0010-one-canonical-tool-contract.md` requires every tool to declare capabilities, permission grammar, context behavior, and evidence emission. `packages/coding-agent/src/core/tools/contract.ts:228` gives a tool without a contract the conservative `UNCLASSIFIED` fallback.
- `docs/roadmap.md:480` already commits to this design. It reads "MCP tools deferred by default with an always-load override," written during Phase 3 and unimplemented since.
- `docs/adr/0013-no-unowned-hosted-service-defaults.md` governs the posture toward remote endpoints. An MCP server is user-named and user-configured, so it sits outside "hosted-service defaults" the same way a user-named OTLP collector does.
- `docs/adr/0015-host-owned-credential-handoff.md` and `docs/adr/0023-supervisor-owned-escalation-authority.md` govern credentials. They are the reason the OAuth subsystem is a non-goal here rather than a smaller version of the upstream one.

## Current state

Apex Code has no MCP implementation. The only references in `packages/coding-agent/src` are three strings:

- `packages/coding-agent/src/core/tools/contract.ts:218` names MCP servers in the comment explaining the `UNCLASSIFIED` fallback, anticipating tools this repo cannot classify.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2636` offers a menu row reading "Resources, extensions, and MCP adapters".
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2661` answers that row with "Run apex-code config to manage resources, extensions, and MCP adapters." That command manages package resources. It cannot configure an MCP server, because none can exist.

All of this is Apex Code's own code, not inherited upstream behavior. Upstream Pi has no MCP support either, so ADR 0003's merge cost for this change is the cost of new files, which is near zero for a three-way merge.

The tool registry is built at `packages/coding-agent/src/core/agent-session.ts:2879`. The default active set is fixed at `packages/coding-agent/src/core/sdk.ts:304` to `read`, `bash`, `edit`, `write`, joined by `lsp` and `web_search` only when those are configured. The enforced static-prefix budget is 2,300 tokens against a measured 2,150, asserted in `packages/coding-agent/test/context/static-prefix.test.ts`.

## The problem

Three problems compound, and only the third is specific to Apex Code.

**No MCP support at all.** A user with a working `.mcp.json` gets nothing. The menu row at `interactive-mode.ts:2636` promises management of "MCP adapters" and the handler sends them to a command that cannot deliver it. That is a false promise shipping today.

**The naive fix breaks the token budget.** Registering each server tool directly costs roughly 150 to 300 tokens of system prompt per tool. Two ordinary servers exceed the entire 2,300-token budget that `static-prefix.test.ts` enforces, before the conversation starts.

**A foreign adapter cannot classify its tools.** This is the decisive one. An extension-registered MCP tool resolves `UNCLASSIFIED` at `contract.ts:228`, which means the full capability set, `defaultBehavior: "ask"`, `resultRecoverable: false`, and permission matching by exact serialized arguments. Reproduce it by pointing any MCP adapter at a server and calling one tool twice with different arguments. The second call prompts again, because `matches` compares `JSON.stringify(params)`. No rule generalizes, and no result is ever evictable. ADR 0010 exists to prevent exactly this, and an adapter outside the repo has no way to satisfy it.

## Goals

- [ ] With one MCP server configured, `packages/coding-agent/test/context/static-prefix.test.ts` stays under its enforced budget, and the delta against zero servers is the `mcp` tool's announced name and description only.
- [ ] Every MCP-sourced tool reports `unclassified: false` on its `ToolInfo` (`packages/coding-agent/src/core/extensions/types.ts:1619`), asserted directly rather than inferred.
- [ ] `mcp({ search: "..." })` and server tool listing return correct results with no server process running, proven by asserting no child process was spawned.
- [ ] A configured server spawns on the first call that needs it, not at session start, and disconnects after its idle timeout.
- [ ] A permission rule `Mcp(github:*)` authorizes every tool on the `github` server, and `Mcp(github:create_issue)` authorizes one. Both round-trip through `ruleForCall` and `matches`.
- [ ] With no `.mcp.json` present, `getActiveToolNames()` and the system prompt are unchanged from today.

## Non-goals

- [ ] **OAuth, the callback server, and a credential store.** ADR 0015 makes credentials host-owned and ADR 0023 puts escalation under the supervisor. Bundling a second credential subsystem contradicts both. Version one reads a bearer token from an environment variable named in config. OAuth gets its own spec once the contract and lifecycle are proven.
- [ ] **Server-initiated sampling and elicitation.** A server asking the model to complete a prompt is a delegation path, and ADR 0008 governs delegation authority with a capability ceiling. Wiring it without that analysis would let a server exceed the session's own grants.
- [ ] **MCP-UI, interactive apps, and the HTML host.** Large surface, no dependency from anything above.
- [ ] **Direct per-tool registration mode.** It is the option that reintroduces the token problem. Add it only if the proxy proves insufficient, with a measurement showing so.
- [ ] **MCP scripting and a worker sandbox.** `bash` and `delegate` already cover orchestration.
- [ ] **Unix socket transport.** Stdio and streamable HTTP cover the deployed ecosystem. Eighty-five lines upstream, but untestable here without a matching server.
- [ ] **Resources and prompts as first-class surfaces.** Tools first. Resources reuse the same cache and lifecycle once tools are proven, so nothing here forecloses them.

## Proposed solution

One tool, one cache, one connection manager, and a contract projection that makes MCP tools first-class under ADR 0010.

| Component | Change | File(s) |
| --- | --- | --- |
| Config model | Parse the ecosystem-standard `{ "mcpServers": { … } }` shape from the project's `.mcp.json` and `~/.apex-code/mcp.json`. Project wins per key. Transport is inferred, never declared. | `packages/coding-agent/src/core/mcp/config.ts` (new) |
| Metadata cache | Persist per-server tool metadata under `~/.apex-code/agent`, keyed by a hash of the server's launch spec. Read on startup, refresh after a successful connect. | `packages/coding-agent/src/core/mcp/metadata-cache.ts` (new) |
| Server manager | Own connect, disconnect, idle timeout, and failure backoff. One state machine per server, never a set of booleans. | `packages/coding-agent/src/core/mcp/server-manager.ts` (new) |
| Proxy tool | The `mcp` tool. Actions are `search`, `describe`, and call. Declares its own contract with `deferSchema: true`. | `packages/coding-agent/src/core/mcp/mcp-tool.ts` (new) |
| Contract projection | Build a `ToolContract` per MCP tool from its server's config entry. Capabilities declared, `ruleContent` grammar owned here. | `packages/coding-agent/src/core/mcp/contract.ts` (new) |
| Registry wiring | Register `mcp` when at least one server is configured, mirroring how `lsp` and `web_search` join the default set. | `packages/coding-agent/src/core/sdk.ts:304`, `packages/coding-agent/src/core/tools/index.ts` |
| Status surface | Replace the menu handler that points at a command which cannot configure MCP. | `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2660` |

**The config format is the ecosystem's, not ours.** Every MCP host (Claude Desktop, Claude Code, Cursor, `pi-mcp-adapter`) reads `{ "mcpServers": { "<name>": { "command": …, "args": […] } } }`. Transport is inferred from which fields are present, `command` meaning stdio and `url` meaning HTTP. No host declares a `transport` field, so requiring one would reject every config file a user already has. Apex Code reads the standard shape unchanged.

`capabilities` is therefore an Apex-only extension to that shape, and an absent one is the common case rather than an edge case, because users will paste a config that another host wrote. Those servers land on the conservative full capability set. The win in that case is not a narrowed capability set; it is that the tool is classified at all, so `Mcp(server:*)` generalizes and the result participates in Eviction. Narrowing capabilities is an opt-in on top.

**Data shapes first**, per **principle-foundational-thinking**. Three types carry the design and are settled before any logic is written.

`McpServerConfig` is the parsed config entry. It holds the transport, the launch spec, the declared capability set, and the lifecycle mode. It is the only place a server's authority is stated.

`ServerState` is a discriminated union, not a set of flags. The variants are `disconnected`, `connecting`, `ready`, and `failed`, each carrying only the data valid in that state. **principle-model-the-domain** drives this. A `connected` boolean beside a `lastError` string is the shape that lets an impossible pair exist.

`CachedTool` is what the disk cache holds: server name, tool name, description, and input schema. Search and describe read only this. That is the property that makes them work with no live connection, so it is a type-level guarantee rather than a convention.

**`buildToolContractSnapshot()` does not exist, so this spec does not cite it.** `AGENTS.md:108`, `CONTEXT.md:35`, and `docs/architecture/contracts.md:236` all specify it, and a repo-wide search returns zero hits in any `.ts` file. `docs/specs/2026-08-18-lsp.md:114` recorded the same gap and declined to cite it for the same reason. This spec follows that precedent. The classification surface that does exist is `ToolInfo.unclassified` at `packages/coding-agent/src/core/extensions/types.ts:1619`, reached through `getAllTools()`, and the goals and verification above name that instead. This is a pre-existing gap between `contracts.md` and the implementation, not one this spec introduces or closes.

**Cold-cache behavior is defined, not left to chance.** A newly configured server has no
cached metadata, so `search` and listing return an explicit miss naming what to do rather
than silently connecting. Two things populate the cache. Any successful tool call caches
that server's full tool list as a side effect, and a server declared `"lifecycle": "eager"`
connects once at session start and caches its tools before the model's first turn. Lazy
stays the default, so nothing connects unbidden; a user who wants a server discoverable
from a cold start opts in. Eager warm-up is detached from session startup and swallows its
own failures, so a broken server delays nothing and stops nothing.

**The rule grammar is settled by [ADR 0025](../adr/0025-mcp-permission-rule-grammar.md).** It names a server and a tool, permits `*` in the tool position only, and gives the metadata actions their own `Mcp(metadata)` rule that cannot authorize a call. Written before the tool shipped, because a rule grammar lands in users' saved settings and can be extended later but never re-spelled.

**Preserving the ADR 0010 seam.** `ruleContent` is interpreted by the tool, never by the rule engine. The `mcp` tool owns both directions of its grammar. `ruleForCall` returns `Mcp(<server>:<tool>)` for a concrete call, and `matches` accepts both that form and `Mcp(<server>:*)`. The permission engine at `packages/coding-agent/src/core/permissions/gate.ts:55` learns nothing new. Capabilities come from the server's config entry rather than being assumed maximal, and a server entry that declares none gets the conservative full set, which preserves the `UNCLASSIFIED` safety property for an under-specified config without applying it to every server by default.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `interactive-mode.ts:2661` status string "Run apex-code config to manage resources, extensions, and MCP adapters." | behavior | Superseded. The command it names cannot configure an MCP server. Replaced by a handler that reports configured servers and their connection state. |
| The MCP clause of the comment at `contract.ts:218` | doc | Retired in part. The comment cites MCP servers as the motivating example of a tool that cannot supply a contract. After this change MCP tools do supply one, so the example becomes third-party extension tools only. The `UNCLASSIFIED` fallback itself stays, unchanged, for those. |

Nothing else is removed. The rest is additive, which is the right shape here because no MCP code exists to replace. The two entries above are both cases of this change making an existing statement untrue, which is the failure mode the inventory is meant to catch.

## Risks

**A server hangs on connect and blocks the tool call.** A stdio server that never completes its handshake would stall the turn. The signal is a call that never returns. Mitigation is a connect timeout in `ServerState.connecting` with a transition to `failed`, plus backoff so a broken server is not retried on every call.

**Cache staleness after a server upgrades its tools.** Search would return a tool the server no longer has, and the call would fail confusingly. The signal is a call failing with an unknown-tool error while search lists it. Mitigation is keying the cache on a hash of the launch spec and refreshing on every successful connect.

**A user declares too narrow a capability set and a legitimate call is denied.** The signal is a denial naming a capability the user did not grant. This is the intended direction to fail, but the error must name the server, the tool, and the missing capability, or it reads as a bug.

**Search relevance collapses on a large server.** With a server exposing over a hundred tools, a weak ranking makes the proxy worse than direct registration. The signal is the model calling `search` repeatedly without converging. This is the measurement that would justify revisiting the direct-registration non-goal.

**Budget creep from the proxy's own description.** The `mcp` tool's description is prompt-resident even with `deferSchema: true`. The signal is `static-prefix.test.ts` moving. The goal above asserts the delta is the announced name and description only.

## Verification

Static gates are `npm run check` and `npm test`, both required.

New tests, each mapping to one goal above:

- `packages/coding-agent/test/context/static-prefix.test.ts` extended with a configured-server case, asserting the budget holds and naming the exact token delta.
- A contract test asserting every MCP tool's `ToolInfo.unclassified` is false, and that `Mcp(server:*)` and `Mcp(server:tool)` round-trip through `ruleForCall` and `matches`.
- A cache test asserting `search` and listing succeed against a pre-populated cache with process spawning stubbed to throw, which proves no connection was attempted.
- A lifecycle test asserting first-call connect, idle disconnect, and that a failed server backs off instead of retrying per call.
- A no-config test asserting `getActiveToolNames()` and the system prompt are unchanged when no `.mcp.json` exists.

Runtime verification on the matching surface, per **principle-prove-it-works**. Drive `apex-code` against one real stdio server and one real HTTP server, and confirm a tool call completes end to end. Unit tests show a branch behaves; they do not show MCP works. The replay corpus is not the instrument here, because no phase gate metric applies to a follow-up.

## Rollout

Needs `docs/plans/2026-08-28-native-mcp.md`, because the work spans six new modules plus registry wiring, and because the phases are independently shippable and should land that way. Order is config model, then cache, then contract projection, then server manager, then the proxy tool, then registry wiring and the status surface. Types and cache land before anything that consumes them, per **principle-foundational-thinking**.

Two decisions may prove irreversible and would each need an ADR rather than being folded in here. The first is the `ruleContent` grammar, because a shipped grammar appears in users' saved permission rules and cannot be changed without breaking them. The second is the on-disk cache format and location, which ADR 0006's migration guarantee would then cover. Write both as ADRs at the point of decision and cite them back here.
