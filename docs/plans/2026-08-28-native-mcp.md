**Status:** Active

# Native MCP implementation plan

**Goal:** Apex Code talks to MCP servers through one `mcp` proxy tool whose every exposed
tool carries a declared contract. Search and listing answer from disk with no server
running. Servers start on first use and stop when idle. A session with no `.mcp.json`
behaves exactly as it does today.

**Spec:** `docs/specs/2026-08-28-native-mcp.md`

**Architecture:** Six units, ordered so every type and store lands before its consumer.
U1 and U2 are pure data with no MCP protocol involvement, so they are testable without a
server. U3 is the ADR 0010 work and is deliberately placed before anything that registers
a tool, because a tool that ships without its contract cannot be retrofitted without
invalidating saved permission rules. U4 introduces the SDK and the first child process.
U5 is the only model-facing surface. U6 wires the registry and settles the spec's
deletion inventory.

**Tech stack:** TypeScript, Vitest, `@modelcontextprotocol/client` and
`@modelcontextprotocol/core` over stdio and streamable HTTP, typebox for the tool schema.

## Task table

| Task | Unit | Status | Commit |
| --- | --- | --- | --- |
| MCP.1 | U1 | Done | pending |
| MCP.2 | U1 | Done | pending |
| MCP.3 | U2 | Not started | — |
| MCP.4 | U2 | Not started | — |
| MCP.5 | U3 | Not started | — |
| MCP.6 | U3 | Not started | — |
| MCP.7 | U4 | Not started | — |
| MCP.8 | U4 | Not started | — |
| MCP.9 | U5 | Not started | — |
| MCP.10 | U5 | Not started | — |
| MCP.11 | U6 | Not started | — |
| MCP.12 | U6 | Not started | — |
| MCP.13 | — | Not started | — |

Order is load-bearing in one place. MCP.5 and MCP.6 must land before MCP.9 and MCP.10.
The `ruleContent` grammar appears in users' saved permission rules the moment a tool
ships, and the spec's Rollout flags it as needing its own ADR for exactly that reason.
Registering the proxy tool before its grammar is settled would make the grammar
unchangeable before anyone has reviewed it.

Everything before MCP.11 is inert. No task from MCP.1 through MCP.10 puts a tool in front
of a model, so each can land on its own without changing any session's behavior.

### MCP.1: Pin the config shape and its failure modes

**Files:**

- Create: `packages/coding-agent/test/mcp/config.test.ts`
- Read: `packages/coding-agent/src/config.ts`
- Read: `packages/coding-agent/src/core/settings-manager.ts`

1. Write failing tests that transport is inferred from the ecosystem-standard shape:
   `command` plus `args` yields stdio, `url` yields HTTP. No `transport` field exists to
   declare, because no MCP host writes one.
2. Write a failing test that a verbatim stock entry parses. Use the exact
   `{"mcpServers":{"chrome-devtools":{"command":"npx","args":["-y","chrome-devtools-mcp@1.6.0"]}}}`
   a user would paste from another host, with no Apex-specific field present.
3. Write failing tests for precedence. A project `.mcp.json` key overrides the same key in
   `~/.apex-code/mcp.json`, and a key present in only one file survives.
4. Write failing tests for the malformed cases, each of which must degrade rather than
   throw: invalid JSON, an entry with neither `command` nor `url`, an entry with both, and
   an unknown lifecycle value. A bad entry drops; the file's good entries survive.
5. Write a failing test that an entry declaring no capability set resolves to the full set.
   This is the common path, not an edge case, because a pasted config carries no
   Apex-specific `capabilities` field.
6. Run `npm --workspace packages/coding-agent test -- mcp/config.test.ts` and confirm every
   test fails because the module does not exist.

### MCP.2: Implement the config model

**Files:**

- Create: `packages/coding-agent/src/core/mcp/types.ts`
- Create: `packages/coding-agent/src/core/mcp/config.ts`
- Test: `packages/coding-agent/test/mcp/config.test.ts`

1. Define `McpServerConfig` in `types.ts` as the single statement of a server's authority:
   transport, launch spec, declared `Capability` set, and lifecycle mode. Import
   `Capability` from `core/tools/contract.ts` rather than restating the union.
2. Define `ServerState` as a discriminated union over `disconnected`, `connecting`,
   `ready`, and `failed`. Each variant carries only the data valid in that state. No
   `connected` boolean and no free-floating `lastError`.
3. Define `CachedTool` holding server name, tool name, description, and input schema, and
   nothing that requires a live connection to produce.
4. Implement the parser and the two-file merge in `config.ts`. Resolve the global path from
   `CONFIG_DIR_NAME` (`src/config.ts:501`) rather than hardcoding `.apex-code`.
5. Make every malformed case return a diagnostic alongside the usable entries. A bad entry
   drops; it never takes the file down.
6. Run the focused test file until green, then `npx tsgo --noEmit`.

**Outcome.** 13 tests, failing first on the missing module, then green. The
transport-inference correction was made before the tests were written, not after: the
reference adapter's `ServerEntry` (`types.ts:409`) has no `transport` field, and its README
example is a bare `{"command":"npx","args":[…]}`. An earlier draft of this plan tested an
"unknown transport" case for a field no MCP host writes, which would have produced a parser
that rejects every config file users already have.

`ALL_CAPABILITIES` is reused from `core/tools/contract.ts` rather than restated, so a new
capability cannot be valid in a tool contract and invalid in an MCP config.

### MCP.3: Prove the cache answers without a connection

**Files:**

- Create: `packages/coding-agent/test/mcp/metadata-cache.test.ts`
- Read: `packages/coding-agent/src/config.ts`

1. Write failing tests for read, write, and round-trip of a `CachedTool` set keyed by a
   hash of the server launch spec.
2. Write a failing test that a changed launch spec produces a different key, so an upgraded
   server does not read stale entries.
3. Write the load-bearing failing test: stub process spawning to throw, then assert that
   listing and searching a populated cache still succeed. This is the test that makes
   "works with no server running" a fact rather than a claim.
4. Write a failing test for a corrupt cache file, which must be discarded and rebuilt
   rather than surfaced as an error.
5. Run the file and confirm the failures are missing-module failures.

### MCP.4: Implement the metadata cache

**Files:**

- Create: `packages/coding-agent/src/core/mcp/metadata-cache.ts`
- Test: `packages/coding-agent/test/mcp/metadata-cache.test.ts`

1. Store under the agent directory resolved by the helper at `src/config.ts:534`, one file
   per cache, not one per server.
2. Key each server's entry on a SHA-256 of its normalized launch spec.
3. Write atomically. Write a temporary file in the same directory, then rename, so a crash
   mid-write cannot leave a torn cache.
4. Treat any parse failure as an empty cache.
5. Run the focused tests until green, then `npx tsgo --noEmit`.

### MCP.5: Pin the tool contract and the rule grammar

**Files:**

- Create: `packages/coding-agent/test/mcp/contract.test.ts`
- Read: `packages/coding-agent/src/core/tools/contract.ts`
- Read: `packages/coding-agent/src/core/permissions/gate.ts`

1. Write failing tests that `matches` accepts `Mcp(github:create_issue)` for that exact
   call, accepts `Mcp(github:*)` for any tool on `github`, and rejects `Mcp(gitlab:*)` for
   a `github` call.
2. Write a failing round-trip test: `ruleForCall` on a concrete call produces a rule that
   `matches` accepts for the same call.
3. Write a failing test that the capability set comes from the server's config entry, and
   that an entry declaring none yields the full set.
4. Write a failing test that `describe` renders a rule a person can read in a permission
   prompt.
5. Write a failing test that a tool built this way reports `unclassified: false` on its
   `ToolInfo` (`src/core/extensions/types.ts:1619`). The spec records why
   `buildToolContractSnapshot()` is not cited.
6. Run the file and confirm the failures are missing-module failures.

### MCP.6: Implement the contract projection

**Files:**

- Create: `packages/coding-agent/src/core/mcp/contract.ts`
- Test: `packages/coding-agent/test/mcp/contract.test.ts`

1. Build a `ToolContract` per MCP tool from its `McpServerConfig`. The tool owns its
   grammar in both directions, per ADR 0010. The permission engine learns nothing.
2. Set `context` to `resultRecoverable: false`, because an MCP call may have side effects
   and is not safely replayable, and `deferSchema: true`.
3. Emit no evidence in this unit. Evidence for MCP calls is a separate question under
   ADR 0007 and is out of the spec's scope.
4. Run the focused tests until green, then `npx tsgo --noEmit`.
5. Before moving on, write the ADR the spec's Rollout names for the `ruleContent` grammar,
   and cite it from the spec. The grammar becomes unchangeable once MCP.10 ships.

### MCP.7: Pin server lifecycle behavior

**Files:**

- Create: `packages/coding-agent/test/mcp/server-manager.test.ts`

1. Write failing tests over `ServerState` transitions, including that no transition can
   produce a state carrying data invalid for it.
2. Write a failing test that a server is not spawned at construction, only on the first
   call that needs it.
3. Write a failing test that a `ready` server with no traffic transitions to
   `disconnected` after its idle timeout.
4. Write a failing test that a server which fails to connect enters `failed` with backoff,
   and that a second call within the backoff window does not respawn it.
5. Write a failing test that a connect which never completes is bounded by a timeout rather
   than hanging the call. This is the spec's first named Risk.

### MCP.8: Implement the server manager

**Files:**

- Create: `packages/coding-agent/src/core/mcp/server-manager.ts`
- Modify: `packages/coding-agent/package.json`
- Test: `packages/coding-agent/test/mcp/server-manager.test.ts`

1. Add `@modelcontextprotocol/client` and `@modelcontextprotocol/core` as pinned exact
   dependencies, per the repo's pinned-dependency check.
2. Implement stdio and streamable HTTP transports only. Unix sockets are a spec non-goal.
3. Drive every transition through the `ServerState` union. No status booleans anywhere in
   this module.
4. Refresh the metadata cache after each successful connect.
5. Read a bearer token from the environment variable the config entry names. No OAuth, no
   credential storage, per ADR 0015 and the spec's non-goals.
6. Run the focused tests until green, then `npx tsgo --noEmit`.

### MCP.9: Pin the proxy tool's model-facing behavior

**Files:**

- Create: `packages/coding-agent/test/mcp/mcp-tool.test.ts`

1. Write failing tests for the three actions: `search` ranks cached tools, `describe`
   returns one tool's schema, and a call reaches the server manager.
2. Write a failing test that `search` and `describe` complete with spawning stubbed to
   throw, inheriting MCP.3's guarantee through the real tool surface.
3. Write a failing test that calling an unknown tool returns a result naming the closest
   matches rather than an unhandled error.
4. Write a failing test that a call to a tool on a `failed` server reports the server's
   state rather than retrying.
5. Write a failing test that the tool's own description stays within a stated character
   budget, which is what keeps MCP.11's prompt-budget assertion from drifting.

### MCP.10: Implement the proxy tool

**Files:**

- Create: `packages/coding-agent/src/core/mcp/mcp-tool.ts`
- Test: `packages/coding-agent/test/mcp/mcp-tool.test.ts`

1. Define the typebox schema for the three actions as one object with mutually exclusive
   fields, validated in the handler.
2. Declare the tool's contract from MCP.6. It is a normal Apex tool, classified like any
   other.
3. Rank search results over cached metadata only. No network call on the search path.
4. Keep the description tight. Every character is prompt-resident even with a deferred
   schema.
5. Run the focused tests until green, then `npx tsgo --noEmit`.

### MCP.11: Wire the registry and hold the budget

**Files:**

- Modify: `packages/coding-agent/src/core/tools/index.ts`
- Modify: `packages/coding-agent/src/core/sdk.ts`
- Modify: `packages/coding-agent/test/context/static-prefix.test.ts`

1. Register `mcp` in the tool registry alongside the existing built-ins.
2. Join it to the default active set only when at least one server is configured, mirroring
   how `lsp` and `web_search` do it at `sdk.ts:304`. The comment there states the rule:
   activating an unconfigured tool puts a name in the prompt that can only ever fail.
3. Extend `static-prefix.test.ts` with a configured-server case. Assert the budget holds and
   record the exact token delta against zero servers.
4. Add the no-config assertion: with no `.mcp.json`, `getActiveToolNames()` and the system
   prompt are unchanged from today.
5. Run `npm --workspace packages/coding-agent test -- context/static-prefix.test.ts` and the
   full `mcp/` directory.

### MCP.12: Settle the deletion inventory

**Files:**

- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Modify: `packages/coding-agent/src/core/tools/contract.ts`

1. Replace the handler at `interactive-mode.ts:2660`. Today it answers the "Resources,
   extensions, and MCP adapters" row by naming a command that cannot configure an MCP
   server. Report configured servers and their `ServerState` instead.
2. Narrow the comment at `contract.ts:218`. It cites MCP servers as the example of a tool
   that cannot supply a contract, which stops being true. The `UNCLASSIFIED` fallback
   itself is unchanged and still serves third-party extension tools.
3. Run `npm run check`.

### MCP.13: Verify on the real surface

**Files:**

- Read: `docs/specs/2026-08-28-native-mcp.md`

1. Run `apex-code` against one real stdio server and one real streamable HTTP server.
   Complete a tool call end to end on each.
2. Confirm the lifecycle by observation, not by unit test: no child process before the
   first call, one after, and none after the idle window.
3. Confirm a permission rule saved as `Mcp(server:*)` authorizes a second, differently
   argued call without a second prompt. This is the defect the spec's Problem section
   names, so it is the one that must be shown fixed on the real surface.
4. Record the run in this plan under a **Verification run, stated as run** heading, with
   the full-suite numbers, matching the house convention.
5. Run root `npm test` and `npm run check` and state both results.
