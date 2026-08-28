# Research: Pi extension references for MCP and structured user questions

**Date:** 2026-08-28  
**Status:** Permanent research note  
**Sources:** `nicobailon/pi-mcp-adapter` at commit [`f3192880de5e87a2ceb2cb5820e50a91eb5ebcb2`](https://github.com/nicobailon/pi-mcp-adapter/tree/f3192880de5e87a2ceb2cb5820e50a91eb5ebcb2) (v2.30.0 plus one commit). `juicesharp/rpiv-mono` at commit [`7bf83f7a15c6611bdc114e2da85c32bfc8feb7b7`](https://github.com/juicesharp/rpiv-mono/tree/7bf83f7a15c6611bdc114e2da85c32bfc8feb7b7) (v2.7.1 plus one commit).  
**Scope:** Two Pi extensions Apex Code may rebuild rather than adopt. The MCP adapter's proxy tool, metadata cache, and server lifecycle. The questionnaire extension's state model, headless handling, and tool schema. Also the extension loader's module alias table, which was tested directly.

This note uses only the public GitHub repositories, the published npm tarballs, and the licenses of both projects. Both are MIT, so ADR 0002 does not restrict them. The **Observed behavior** section records facts, each one either read from source or produced by a command recorded here. The **Recommendations for Apex Code** section is design guidance and carries opinion.

A third extension, `pi-agent-browser-native`, was considered and set aside. It wraps a separate Apache-2.0 CLI that must already be on `PATH`, so it is not a rebuild candidate. Nothing in this note is verified about it.

## Observed behavior

### Source map

| Concern | Upstream source |
| --- | --- |
| MCP proxy tool, `search` and `describe` and call | [`proxy-modes.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/f3192880de5e87a2ceb2cb5820e50a91eb5ebcb2/proxy-modes.ts) |
| Server connection lifecycle | [`server-manager.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/f3192880de5e87a2ceb2cb5820e50a91eb5ebcb2/server-manager.ts), [`lifecycle.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/f3192880de5e87a2ceb2cb5820e50a91eb5ebcb2/lifecycle.ts) |
| Disk metadata cache | [`metadata-cache.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/f3192880de5e87a2ceb2cb5820e50a91eb5ebcb2/metadata-cache.ts) |
| Tool name prefixing | [`namespace-tools.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/f3192880de5e87a2ceb2cb5820e50a91eb5ebcb2/namespace-tools.ts) |
| Questionnaire state and reducer | [`state/state.ts`](https://github.com/juicesharp/rpiv-mono/blob/7bf83f7a15c6611bdc114e2da85c32bfc8feb7b7/packages/rpiv-ask-user-question/state/state.ts), [`state/state-reducer.ts`](https://github.com/juicesharp/rpiv-mono/blob/7bf83f7a15c6611bdc114e2da85c32bfc8feb7b7/packages/rpiv-ask-user-question/state/state-reducer.ts) |
| Row kind metadata table | [`state/row-intent.ts`](https://github.com/juicesharp/rpiv-mono/blob/7bf83f7a15c6611bdc114e2da85c32bfc8feb7b7/packages/rpiv-ask-user-question/state/row-intent.ts) |
| Headless tool stripping | [`reconcile.ts`](https://github.com/juicesharp/rpiv-mono/blob/7bf83f7a15c6611bdc114e2da85c32bfc8feb7b7/packages/rpiv-ask-user-question/reconcile.ts) |
| RPC dialog walker | [`rpc-fallback.ts`](https://github.com/juicesharp/rpiv-mono/blob/7bf83f7a15c6611bdc114e2da85c32bfc8feb7b7/packages/rpiv-ask-user-question/rpc-fallback.ts) |
| Tool schema and limits | [`tool/types.ts`](https://github.com/juicesharp/rpiv-mono/blob/7bf83f7a15c6611bdc114e2da85c32bfc8feb7b7/packages/rpiv-ask-user-question/tool/types.ts) |

### The loader resolves the legacy upstream scope but not the current one

`getAliases()` and `VIRTUAL_MODULES` in `packages/coding-agent/src/core/extensions/loader.ts` map `apex-code`, `apex-code-agent-core`, `@earendil-works/pi-tui`, the four `@earendil-works/pi-ai` entry points, and the whole legacy `@mariozechner/*` scope. They do not map `@earendil-works/pi-coding-agent`, which is the scope every current registry extension imports.

Three probe extensions, each importing `getMarkdownTheme` from a different specifier, were loaded through `loadExtensions()` from the built `packages/coding-agent/dist/core/extensions/loader.js`:

```
LOAD  ext-apex.ts
LOAD  ext-mariozechner.ts
FAIL  ext-earendil.ts  Cannot find module '@earendil-works/pi-coding-agent'
```

`docs/upstream-log.md` line 432 records that a merge saw this key asserted by an upstream test and resolved it by changing the test, which was correct for that test and left the alias absent.

The gap matters only for running third-party extensions unmodified. Code written inside Apex Code imports `apex-code` and never meets it.

### Both extensions need almost nothing from that scope at runtime

Most imports of `@earendil-works/pi-coding-agent` in both packages are `import type`, which is erased before execution. `@juicesharp/rpiv-ask-user-question` imports one value, `getMarkdownTheme`. `pi-mcp-adapter` imports one value, `copyToClipboard`. Apex Code exports both from `packages/coding-agent/src/index.ts` at lines 419 and 428.

### The questionnaire is a reducer over one canonical state shape

`state/state.ts` defines `QuestionnaireState` as the single source of truth that both the key dispatcher and the view read. It separates per-tick runtime data into `QuestionnaireRuntime` so keybindings and the input buffer never reach view props.

Two fields carry design decisions worth keeping. `notesByTab` is held apart from `answers` so attaching a note does not mark a question answered, which would otherwise let the submit-tab completeness check pass falsely. `customDraftsByTab` holds an in-flight typed answer per tab, where a present empty string overrides an older answer.

### A per-row-kind table forces compile-time exhaustiveness

`state/row-intent.ts` derives `RowKind` from the view's `WrappingSelectItem` union and declares `ROW_INTENT_META` as a `Record<RowKind, RowIntentMeta>`. The table is pure data with no closures and no per-kind handler functions. Behavior-bearing code keeps its own exhaustive switches and reads flags such as `livesInMainList`, `numbered`, `activatesInputMode`, `blocksMultiToggle`, and `autoSubmitsInMulti` from the table.

Adding a row variant fails to compile until its metadata entry exists. The reserved-label set and the sentinel label map are both derived from the same table rather than restated.

### Both projects keep UI-only tools away from a headless model, by different means

`reconcile.ts` is 47 lines. It reads the active tool list at runtime, then strips `ask_user_question` when `ctx.hasUI` is false and restores it when true. It is idempotent and leaves sibling tools untouched.

Apex Code reaches the same end state earlier and more simply. `ask_user` and `plan_present` are registered but are not members of the default active set, which `sdk.ts` lines 304 to 308 fix at `read`, `bash`, `edit`, and `write` plus `lsp` and `web_search` when those are configured. A default session therefore never advertises either tool. Verified by reading the active list off a real `AgentSession`, which returns exactly `["bash", "edit", "read", "write"]` while `getAllTools()` includes both UI-only tools.

The `hasUI` throws at `ask-user.ts` lines 53 to 57 and `plan-present.ts` lines 58 to 62 are the backstop for the only way either tool becomes active, which is a user naming it through `--tools` or the `defaultTools` setting. The comment at `sdk.ts` line 300 states the governing rule, that activating an unconfigured tool would put a name in the prompt that can only ever fail.

Apex Code needs no change here. rpiv's runtime reconcile is the right pattern for an extension, which cannot influence the default active set. It is not needed for a built-in tool.

### RPC hosts report a UI that the overlay path cannot render

`rpc-fallback.ts` records that RPC and ACP hosts such as the VS Code pendant and Zed report `hasUI: true` because the dialog sub-protocol works, but `ui.custom()` resolves `undefined` without rendering. The module walks the questions sequentially through `ui.select()` and `ui.input()` instead, and returns the same result shapes the terminal path produces.

Apex Code builds its own RPC `ExtensionUIContext` in `packages/coding-agent/src/modes/rpc/rpc-mode.ts` line 137, so the same hazard exists here.

### The tool schema follows Claude Code's public tool surface

`tool/types.ts` sets four questions maximum, two to four options per question, a 16-character header limit, and a 60-character option label limit. Each option carries a label, a description, and an optional markdown `preview`.

The source comment on `RESERVED_LABELS` states that `"Other"` is reserved "for CC parity only (the model is conditioned to reach for 'Other' in CC)". The authors modeled the schema on Claude Code's observable tool surface, not on its source. That is behavior, so ADR 0002 permits it, and this note records the lineage rather than presenting the shape as novel.

### The MCP adapter replaces per-tool schemas with one proxy tool

The adapter registers a single `mcp()` tool. `mcp({ search: "..." })` ranks cached tool metadata, `mcp({ server: "name" })` lists a server's tools, and `mcp({ tool: "...", args: {...} })` calls one. The README states the motivation as context cost, since a single MCP server's full tool definitions can exceed 10,000 tokens.

`metadata-cache.ts` persists tool, prompt, and resource metadata to disk under the agent directory. Search and list therefore answer with no server running. `lifecycle.ts` offers `lazy`, `eager`, `keep-alive`, and `lazy-keep-alive`, with lazy the default and a ten-minute idle disconnect.

This is the design `docs/roadmap.md` line 480 already commits Apex Code to, which reads "MCP tools deferred by default with an always-load override."

### Two thirds of the adapter is optional for a first version

Counts regenerate with this command, run at the pinned commit:

```sh
find . -name '*.ts' -not -path './node_modules/*' -not -path './.git/*' \
  -not -path './dist/*' -not -name '*.test.ts' | xargs wc -l | tail -1
```

| Set | Lines | Files |
| --- | --- | --- |
| All non-test source | 25,627 | whole package |
| Core | 6,466 | `proxy-modes`, `server-manager`, `config`, `types`, `lifecycle`, `metadata-cache`, `namespace-tools`, `tool-registrar`, `unix-socket-transport` |
| Deferrable | 8,444 | the OAuth stack, the callback server, the bearer store, both TUI panels, the UI server, the HTML host template, direct tools, the scripting mode |

`config.ts` alone is 1,285 lines because it resolves project, global, and agent-specific config file locations with several precedence rules.

### The questionnaire package carries two test lines per source line

`@juicesharp/rpiv-ask-user-question` holds 5,204 lines of source and 10,433 lines of tests. The nine files worth modeling on total 1,612 lines. Counts regenerate with `find . -name '*.ts' -not -name '*.test.ts' -not -name 'test-fixtures.ts' | xargs wc -l | tail -1` inside `packages/rpiv-ask-user-question`.

### Both projects are MIT

`pi-mcp-adapter` is MIT, copyright 2026 Nico Bailon. `rpiv-mono` is MIT, copyright 2026 juicesharp, and the questionnaire package restates MIT in its own `package.json`. ADR 0002 restricts unlicensed sources. It does not restrict these. Copying substantial code requires a `NOTICE` entry. Taking design only requires this note.

## Recommendations for Apex Code

### Keep the default active set as the gate, and do not port rpiv's reconcile

An earlier draft of this note recommended excluding `ask_user` and `plan_present` from a headless session's active tool list. That recommendation was withdrawn after the behavior was measured. Neither tool is in the default active set, so no change is needed.

Preserve the existing rule when adding any future UI-only tool. Register it, leave it out of `defaultActiveToolNames` in `sdk.ts`, and keep a `ctx.hasUI` guard in the handler for the explicit `--tools` case. A new tool that is active by default and fails without a UI would be the actual defect.

### Model the questionnaire as a reducer plus a row-intent table

Build the state shape first, per ADR 0010's habit of declaring rather than deriving. Hold notes apart from answers so a note never marks a question answered. Derive the row kinds from one `Record<RowKind, RowIntentMeta>` table so a new row variant cannot compile until its metadata exists.

Reuse `ui.custom()`, which `createExtensionUIContext` already exposes at `packages/coding-agent/src/modes/interactive/interactive-mode.ts` line 2531. Skip the upstream i18n bridge, the nine locales, the `@juicesharp/rpiv-config` dependency, and the `~/.config` key-binding file. Apex Code has a settings system.

Handle the RPC case explicitly. Test that the tool works in `--mode rpc`, because `hasUI` is true there and `ui.custom()` is not the path that runs.

### Give MCP tools a real tool contract

This is the reason to build rather than adopt. A registered tool with no `contract` resolves to `UNCLASSIFIED` in `packages/coding-agent/src/core/tools/contract.ts` lines 228 to 238. That means the full capability set, `ask` by default, `resultRecoverable: false`, and rule matching by exact serialized arguments.

For one tool that is a safe default. For a server exposing seventy, it asks the user again for every new argument set, generalizes into no rule, and never permits Eviction. Apex Code's own permission model exists to prevent this.

A native adapter should declare capabilities per server from configuration rather than assuming all seven, own a `ruleContent` grammar shaped like `Mcp(server:tool)` and `Mcp(server:*)`, and set `deferSchema: true`.

### Scope the first MCP version to the proxy, the cache, and the lifecycle

Take the proxy tool, the disk metadata cache, and lazy connection with an idle disconnect. Read `.mcp.json` from the project and one global location, not the full precedence chain.

Defer the whole 8,444-line set named above. Start with bearer tokens from the environment. Authentication belongs on Apex Code's supervisor-mediated credential path under ADR 0015 and ADR 0023, not in a second credential store bundled with the adapter.

### Treat the loader alias as ecosystem compatibility, not a prerequisite

Adding `@earendil-works/pi-coding-agent` to both maps in `loader.ts` is two lines and makes current third-party extensions loadable. It is not required for any work recommended here, because code written inside Apex Code imports `apex-code`.

Decide it on its own merits as a question about running other people's extensions. Do not sequence the MCP or questionnaire work behind it.

## Verification targets for the implementation spec

- A newly added UI-only tool is absent from `getActiveToolNames()` on a default session, asserted against the four-tool default rather than against a thrown error.
- The questionnaire tool completes a full answer cycle in `--mode rpc`, not only in the terminal.
- Adding a row kind to the questionnaire's item union fails the typecheck until its `ROW_INTENT_META` entry exists.
- Every MCP tool reports a declared contract, and none resolves to `UNCLASSIFIED`, asserted through `buildToolContractSnapshot()`.
- `mcp` search and list answer correctly with no server process running, proving the cache is authoritative.
- The static prefix stays inside the budget enforced by `test/context/static-prefix.test.ts` with a configured MCP server present.
