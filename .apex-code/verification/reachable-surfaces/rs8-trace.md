# RS.8 / RS.9 subsystem trace

Read-only source trace, 2026-10-03. No production or test files changed. Latest spec G4 and live plan RS.8/RS.9 read before tracing. AGENTS, CONTEXT, roadmap, ADR 0003 read. Root reports RS.1–RS.7 full-suite baseline green; this trace did not rerun verification.

## Overview

Task state already lives in session custom entries. RS.8 should project the latest snapshot from the current unabridged branch into fixed composer chrome, and attach a compact built-in renderer through the existing renderer registry. RS.9 adds a saved initial-tool selection control. The current system provides neither a task-panel caller nor an active-tools observer.

## Key Concepts

- A todo call is a complete replacement, including an empty list. `TodoItem` is `{ content, status }` with `pending`, `in_progress`, or `completed` (`packages/coding-agent/src/core/tools/todo-write.ts:6`).
- `getLatestTodos(entries)` scans backward for the last `customType: "todo"` and returns its data or `[]` (`core/session-manager.ts:413`). Pass `sessionManager.getBranch()` (`:1573`), which includes all ancestor entry types. `getEntries()` includes other branches, and `buildContextEntries()` deliberately excludes entries removed by compaction (`:526`), so neither is the right panel source.
- Panel expansion is presentation preference, separate from the task snapshot and active tool loadout. Global `chatDetail` read/write methods provide the existing persistence pattern (`core/settings-manager.ts:1421`).
- Fixed chrome lives outside transcript components. `createChatViewport` puts `widgetsAbove` inside the dock, ahead of the editor, and gives it shrinkable zero-minimum space on short terminals (`modes/interactive/chat-viewport.ts:27`).

## How It Works

### Store and branch

`AgentSession._buildRuntime()` injects a todo store whose `write(todos)` appends a `todo` custom entry (`core/agent-session.ts:4495`). Tool execution persists the snapshot before returning `details: { todos }` (`core/tools/todo-write.ts:59`). Reading the branch at successful tool completion therefore observes the new list without interpreting rendered result text.

The injected store calls `SessionManager.appendCustomEntry()` directly. It does **not** emit the existing session `entry_appended` notification. An extension may independently append custom entries through the session manager. A controller watching only `entry_appended` would miss the ordinary todo-write path and direct custom-entry mutations.

Tree navigation changes the leaf, refreshes finalized context, and restores tools, then emits `session_tree` to **extensions**, not the public `AgentSession.subscribe()` listeners (`core/agent-session.ts:5026`). Both interactive tree adapters already call `renderInitialMessages()` after successful navigation (`interactive-mode.ts:2132`, `:6070`). That is a practical panel refresh seam. Direct SDK `navigateTree()` is outside those adapters; a live branch getter covers it on the next requested frame, while a fully event-driven panel needs an additional public notification.

Compaction changes model/transcript projection but keeps the underlying ancestor chain. Recompute from `getBranch()`, never the reduced projection. `rebuildChatFromMessages()` uses reduced context entries (`interactive-mode.ts:4463`), so simply deriving panel state from its supplied render entries loses pre-compaction todo snapshots.

### Composer and lifecycle

`InteractiveMode` owns the above/below widget containers and extension widget maps (`interactive-mode.ts:659`). `renderWidgets()` calls `renderWidgetContainer()`, which clears its container and reconstructs extension children (`:2601`, `:2614`). Adding a task component once to `widgetContainerAbove` is unstable: the next extension widget update removes it. Keep a core-owned component or sub-container and compose it separately from the extension map; extensions must not dispose, replace, or truncate the core panel.

The same above-widget component tree mounts in fullscreen and main-screen layouts (`interactive-mode.ts:1064`, `:1083`). No `pi-tui` patch is needed. `ComposerDock` is the replacement-picker/editor slot, with an inset for substitute components (`components/composer-dock.ts:11`); the task panel belongs above it, not inside it.

On session replacement, `AgentSessionRuntime` invokes before-invalidate and rebind callbacks (`core/agent-session-runtime.ts:176`, `:189`). Interactive rebind unsubscribes old listeners, applies settings, renders the replacement state before extension startup when requested, then subscribes (`interactive-mode.ts:2198`). Session/settings accessors always read `runtimeHost.session` (`:690`). Bind panel getters to those accessors or rebuild cached snapshots on rebind so the previous session cannot remain visible during asynchronous extension startup.

`renderCurrentSessionState()` clears chat and pending tool components and calls `renderInitialMessages()` (`interactive-mode.ts:2297`). Reload rebuilds the registry using explicitly requested names, preserving the current loadout rather than reapplying `defaultTools` (`core/agent-session.ts:4548`). `applyRuntimeSettings()` is the settings refresh seam (`interactive-mode.ts:2171`).

The ordinary public event subscription delegates to `handleEvent()` (`interactive-mode.ts:3583`). Relevant points are successful `tool_execution_end` (`:3832`), `agent_end` (`:3843`), and `agent_settled` (`:3870`). Completing every item should keep the current panel until the end of the turn per spec; resumed/all-complete idle state should hide immediately. Define turn-end timing for retries explicitly: `agent_end` carries `willRetry`, while `agent_settled` marks completion of the whole preparation/run lifecycle.

### Active tool gating and hooks

`getActiveToolNames()` reads actual `agent.state.tools` (`core/agent-session.ts:1944`). `setActiveToolsByName()` updates requested intent and calls `_applyRequestedTools()` (`:1983`). `_applyRequestedTools()` directly updates `agent.state.tools` and rebuilds the prompt (`:2000`), with **no public active-tools event**. The public `AgentSessionEvent` union has no loadout event (`:226`). Therefore a panel refreshed only on todo results/tree/bind cannot reliably hide or reappear after idle SDK/extension setter changes.

`before_agent_start` handlers may modify run-scoped `selectedTools` or call the persistent setter (`core/agent-session.ts:2516`). The resulting run loadout is authoritative, and it can differ from the base requested selection. Gate against actual active names, not `defaultTools`, the registry, or requested intent. The registry answers whether a tool is admitted, not whether it is currently active.

Two actual implementation choices:

1. A panel with a live active-tool getter evaluates `getActiveToolNames()` at render time; cache the branch snapshot outside each frame. This tracks silent loadout changes **when a frame is rendered**, but setters themselves currently do not request a frame. Avoid claiming immediate idle refresh without proving a frame trigger. Cache invalidation must cover successful todo calls, bind/load, tree, compaction and direct custom-entry paths if those are in scope.
2. An explicit session loadout notification centralizes changes at `_applyRequestedTools()` and lets the UI request a frame. This is additional public surface and must cover hook run application/cleanup, not only SDK setters. Branch notifications still need their own lifecycle strategy; no existing event provides all changes for free.

### Compact tool cell and disclosure

`InteractiveMode.getRegisteredToolDefinition()` calls `withBuiltInRenderers(name, session.getToolDefinition(name))` (`interactive-mode.ts:2331`). `core/tools/renderers/index.ts:40` defines the built-in rendered-name subset; `:46` maps names to renderer-only implementations; `:64` merges them without overriding extension-defined renderers. Add `todo_write` there with a renderer-only module, preserving the architecture that avoids importing execution/typebox code into display-only processes.

`ToolExecutionComponent` supports `renderCall`/`renderResult`, receives `expanded` and error state in the render context (`components/tool-execution.ts:157`), and provides per-call mouse disclosure (`:402`). It currently falls back to the tool name plus result text for registered tools without custom renderers (`:434`). Render the compact task count from typed details on success; failed calls must retain the real error message rather than masquerading as updates. A one-line summary must not accidentally duplicate call and result labels; count and disclosure behavior need actual component render assertions. Existing Ctrl+O applies expansion through `adoptChatDetail()` (`interactive-mode.ts:4762`).

### Settings, command, and key

`getDefaultTools()` returns a copy of merged effective defaults; there is no corresponding setter (`core/settings-manager.ts:1699`). SDK defaults are the core four plus configured LSP/search/MCP; `configuredDefaultToolNames ?? defaultActiveToolNames` determines initial selection (`core/sdk.ts:440`). Enabling the first saved task toggle must preserve those effective defaults rather than replacing an unset array with `["todo_write"]`. Persist user/global defaults using the settings-manager mark/save pattern, preserve unrelated selected names/order, and define how project settings shadow the saved global value.

RS.9 calls for changing future-session defaults. Reload already preserves requested active tools, so do not promise that changing this saved default enables the current session unless implementing that extra behavior deliberately, with restrictive registries respected. CLI explicit `--tools`, exclusions and `--no-tools` retain precedence over defaults (`core/sdk.ts:452`).

Settings selector follows config/callback/row/dispatch layers (`components/settings-selector.ts:147`, `:172`, `:697`, `:1071`), instantiated and supplied callbacks in `interactive-mode.ts:5270`. Add focused settings-selector tests exercising the actual row rather than only the new settings setter.

Register `/tasks` in `core/slash-commands.ts:19` and dispatch it beside `/settings` (`interactive-mode.ts:3372`). The built-in list drives help, autocomplete, and extension-command conflict diagnostics (`:792`, `:821`), so a dispatch-only command leaves those surfaces inconsistent.

Add the action to both `AppKeybindings` and `KEYBINDINGS` (`core/keybindings.ts:15`, `:74`), wire editor action registration (`interactive-mode.ts:3272`), and reserve its resolved shortcuts in `core/extensions/runner.ts:92`. Ctrl+T is occupied. Read-only literal search found no `alt+j` in either current app definitions or installed pi-tui defaults; `alt+y` and Ctrl+G are occupied. A candidate such as Alt+J still needs the effective-key collision test across platform defaults and public key parsing. Record the chosen key and Meta requirement in user docs.

## Where Things Live

| Concern | Ownership |
| --- | --- |
| Todo schema, execution, result details | `core/tools/todo-write.ts` |
| Branch snapshot reader | `core/session-manager.ts:421` |
| Session registry/store/hook loadouts | `core/agent-session.ts:1983`, `:2516`, `:4495` |
| Session replacement orchestration | `core/agent-session-runtime.ts:176` |
| Panel composition, commands, events | `modes/interactive/interactive-mode.ts` |
| Proposed standalone panel | `modes/interactive/components/task-panel.ts` |
| Compact renderer lookup | `core/tools/renderers/index.ts:64` |
| Global preference and default selection | `core/settings-manager.ts:1421`, `:1699` |
| Settings row | `modes/interactive/components/settings-selector.ts` |
| Fixed fullscreen dock | `modes/interactive/chat-viewport.ts:27` |
| Frame cost | `test/streaming-render-bench.ts:81`, `:146`, `:217` |

## Gotchas

- The existing streaming benchmark constructs assistant/tool transcript containers, not the production composer/widget dock. Its three scenarios contain no task panel. Running it alone checks general regression but does not measure the added panel. Add a representative panel/dock scenario or separately measure the actual component in a mounted frame; keep identical scenarios across baseline/head.
- Benchmark source comments suggest plain tsx, but AGENTS requires `npx tsx --tsconfig tsconfig.runtime.json <file>` from the repository root. Compare baseline and head back to back on an idle host; uniform scaling of untouched scenarios is contamination.
- Expanded task rows must be single terminal lines even when contents contain newlines, ANSI escapes, long text, Unicode or narrow widths. Otherwise a five-item cap does not actually bound dock height. Reuse safe display normalization and terminal-width truncation rather than character slicing.
- `getLatestTodos()` currently casts custom data, so corrupt/legacy/session-import payloads can fail naive `.filter()`/`.map()` use. Decide whether the presentation validates defensively or treats the persisted schema as authoritative; test the chosen public behavior.
- Full branch scanning on each streamed frame is avoidable. Prefer snapshot refresh at state seams plus cheap active-name gating. A controller can cache by session identity and leaf ID but must account for direct mutation of custom-entry data if such mutation is supported; there is no immutable snapshot contract in this trace.
- ADR 0003's ceiling is 159 conflicted hunks, not a LOC budget. Keep integration edits localized and standalone task rendering in a new component; do not broadly refactor InteractiveMode for this feature or change consumed pi-tui.
- Tests driving sessions/turns must use scratch cwd. Verify actual component/mode boundaries for task lifecycle, tool success/error disclosure, settings interaction, and SDK/hook gating. Source reading is evidence of seams, not runtime verification.
