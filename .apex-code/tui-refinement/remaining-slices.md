# Remaining TUI refinement slices

**Inspection basis:** Apex Code `829a9c851` plus the in-progress tool-card/tray worktree on 2026-08-23. This report inspected only this repository. It did not inspect `c-code`.

## Boundaries and shared seams

- Keep all presentation code in `packages/coding-agent`. `packages/tui` is an upstream dependency and is frozen by ADR 0001.
- `InteractiveMode` already owns the transcript, dock, editor replacement, focus restoration, and agent-event wiring. Prefer small components plus callbacks over adding more rendering logic to this 6k-line class.
- Keep `ToolExecutionComponent` as the lifecycle source. It receives streamed args, execution start, partial results, final results, errors, expansion, and replay. A renderer must not infer risk or capability from a tool name.
- Reuse the existing global `app.tools.expand` action. Do not introduce per-card focus or a second disclosure state.
- Use ANSI-aware `Text`, `truncateToWidth`, and `visibleWidth`. Every new component needs narrow-width tests.

## Recommended order

1. Collapsed errors and elapsed labels, while the new tool shell is fresh.
2. Delegation summaries, which use that disclosure behavior.
3. Contextual first-use hints.
4. Composer polish.
5. Unified configuration navigation.

The first three can share one small presentation utility layer. Configuration navigation is the largest orchestration change and should land last.

## Slice 1 — bounded collapsed errors

**Current seam.** `ToolExecutionComponent.updateResult()` retains the full result and passes `expanded` plus `isError` through `ToolRenderContext`. Built-in renderers commonly show an error in full even while collapsed; for example, `formatReadResult()` returns early only for a collapsed *success*. Generic fallback output is also unbounded. `InteractiveMode.showError()` and `showExtensionError()` are separate transcript paths; the latter also emits a full stack.

**Architecture.** Bound tool-result errors at the tool shell, after the renderer has produced content, rather than changing every tool or its model-facing result. Keep the full renderer component/result alive and select one of two views:

- collapsed: stable header plus a small visual-line budget (suggested 3–5 lines), omitted-line count, and the single shell-owned expand hint;
- expanded: the renderer's complete error output.

Use visual rows, not `string.split("\n")`, because wrapping changes the actual terminal height. `components/visual-truncate.ts` is an existing width-aware helper, but it is tail-oriented. Errors normally need the first line/name and leading context, so either extend it with an explicit `head | tail` direction or add a small error-specific component. Do not mutate `result.content`; the model, evidence, export, and replay paths must retain the full error.

Limit this slice to tool errors unless the spec is expanded. Standalone `showError()` and extension stacks have different disclosure and expansion ownership. They should not silently become controlled by `app.tools.expand`.

**Test seam.** Extend `test/tool-execution-component.test.ts` at the public `render(width)` boundary:

- long generic and built-in errors are bounded while collapsed;
- the first diagnostic line is retained and an omitted-line count is shown;
- expansion restores the exact full text and removes the hint;
- short errors are unchanged;
- wrapped, ANSI, Unicode, width 1–80, custom-renderer, and self-shell cases stay within width;
- successful results keep their existing compact behavior.

## Slice 2 — elapsed activity labels

**Current seam.** Generic tools expose `markExecutionStarted()` and final `updateResult()`, but `ToolExecutionComponent` stores no timing. The bash tool has private renderer timing in `core/tools/bash.ts`; inline `!` commands use the separate `BashExecutionComponent`. Working, compaction, retry, and branch-summary rows derive from `StatusIndicator`, which wraps `pi-tui`'s `Loader`. Only retry currently owns a timer.

**Architecture.** Add one Apex-owned elapsed formatter/ticker with injected `now` for deterministic tests. Use a stable, non-animated text label such as `elapsed 12s`; the existing spinner can remain the activity signal. Recommended ownership:

- `ToolExecutionComponent`: capture start in `markExecutionStarted()`, freeze end in final `updateResult()`, and expose elapsed in the stable tool summary/header;
- `StatusIndicator`: optionally compose the same label for working, compaction, and branch-summary operations;
- `BashExecutionComponent`: adopt the helper if inline shell activity is in scope, so `!` and tool `bash` do not disagree.

Only tick while running. Add `dispose()` and call it on success, error, abort, component replacement, rebuild, and `agent_end`; clearing `pendingTools` alone is not timer cleanup. Replayed tool entries lack persisted start timestamps, so omit elapsed rather than invent it. Background delegation duration is the child's execution duration only when the result is retrieved in-process; do not derive it from the handle UUID or transcript timestamps.

**Test seam.** Use fake timers in `test/tool-execution-component.test.ts`, `test/status-indicator.test.ts`, and, if included, `test/bash-execution-width.test.ts`:

- no elapsed label before execution starts;
- deterministic boundary formatting at 999 ms, 1 s, 59 s, 60 s, and longer durations;
- live labels advance, final labels freeze;
- success, error, abort, and dispose stop render requests/timers;
- custom working messages and custom indicators remain intact;
- replay without timing omits the label;
- every rendered row remains width-safe.

## Slice 3 — delegation summaries

**Current seam.** `createDelegateToolDefinition()` has no `renderCall` or `renderResult`, so it falls through to the generic tool renderer. Its stable presentation data already exists in `DelegateInput` and `DelegateDetails`: agent type, task, output, and optional background handle. The runtime owns authority, depth, artifact directories, child execution, and retrieval; none of that belongs in the TUI.

**Architecture.** Add delegate-specific renderers to `core/tools/delegate.ts`, following the other first-party tool definitions:

- call row: agent type plus a width-bounded task summary;
- foreground completion: `agent • done` plus factual output line/character count;
- background start: `agent • running in background` and a shortened/display-safe handle only if it helps retrieval;
- retrieval completion: the same stable completion shape;
- expanded result: full child output;
- error: use the shared bounded-error path.

The collapsed parent row must not copy the child transcript or claim child tools/capabilities. The runtime's returned `details` is the source; the renderer must not read child session files or artifact directories. Keep the tool contract, permission grammar, evidence capture, and execution result unchanged.

**Test seam.** Add renderer cases to `test/tools/delegate.test.ts` or a focused `test/delegate-renderer.test.ts`, then one composition case in `test/tool-execution-component.test.ts`:

- foreground, background-start, background-retrieval, and error summaries;
- long task/output/handle and narrow-width safety;
- collapsed output does not contain child body; expanded output does;
- no duplicated output or disclosure hint;
- existing runtime, ceiling, depth, permission, evidence, and end-to-end tests remain unchanged.

## Slice 4 — contextual first-use hints

**Current seam.** Most help is startup-only in `ApexSplashHeader`; queue restore help is emitted whenever a queue exists; tool renderers currently repeat expansion hints. `SettingsManager` already has a safe global persistence pattern for `lastChangelogVersion`, but no general hint state. `InteractiveMode` exposes the relevant events: first collapsed result, first queue, first thinking block, first bash mode, and first delegation.

**Architecture.** Introduce a pure `FirstUseHints` controller with a closed hint-id union and methods such as `offer(event): Hint | undefined` and `markSeen(id)`. Persist a versioned set/map in global settings, not session JSONL. Unknown future IDs must be ignored safely. Event handlers should request a hint only when the feature is actually usable and a keybinding exists.

Render hints as dim transcript notices or a dedicated low-priority hint container. Never replace `statusContainer`, footer permission/context state, warnings, or errors. Emit at most once per user profile, at most one per event, and never during replay/rebuild. Good initial candidates are queue dequeue, tool expansion, thinking toggle, and bash Escape. Avoid random tips and avoid teaching actions already printed on the same row.

**Test seam.** Add a pure `test/first-use-hints.test.ts` plus narrow integration cases in `interactive-mode-status.test.ts` and `settings-manager.test.ts`:

- relevant event emits once; unrelated events do not;
- persisted seen state survives manager recreation and merges with project settings correctly;
- replay/rebuild does not re-emit;
- missing keybinding suppresses or rewrites the hint;
- warning/error/status content remains present when a hint is offered;
- queue and tool components do not duplicate the same instruction.

## Slice 5 — Apex-owned composer styling

**Current seam.** `CustomEditor` already owns Apex's `> ` prefix, placeholder, slash-command tint, ANSI/cursor handling, and width reservation. `InteractiveMode` detects bash mode and changes only the inherited border color. The public upstream `EditorOptions` exposes padding and autocomplete height, not a background or border-content hook. Extension editors are replaceable through `setCustomEditorComponent()`.

**Architecture.** Keep the work inside `CustomEditor` and its constructor/state wiring. Model composer presentation as an explicit state, for example `prompt | bash | busy`, and expose a small setter. Safe changes include a dynamic text prefix, an explicit color-independent bash label, spacing, placeholder wording, and mode feedback. Post-process only lines that `CustomEditor` can classify exactly. Do not fake a filled background by painting terminal-width spaces around the inherited editor; that risks cursor markers, autocomplete rows, IME placement, and narrow-width wrapping. If the desired fill cannot be expressed through the public API, record it as unsupported rather than changing `packages/tui`.

Keep extension compatibility explicit: Apex chrome applies to the default editor. Replacement editors continue to receive the existing copied border/padding/autocomplete settings and are not assumed to implement new private methods.

**Test seam.** Extend `test/custom-editor-chrome.test.ts` and one `interactive-mode-status.test.ts` wiring case:

- prompt/bash state changes are textual as well as colored;
- multiline input, scrolling borders, autocomplete, focused/unfocused hardware cursor, paste markers, slash tint, Unicode, and widths 1–120 remain correct;
- every line stays within width and cursor marker count/position is unchanged;
- transitions caused by typing/removing `!`, Escape, submission, and editor replacement restore the right state;
- no `packages/tui` diff.

## Slice 6 — unified configuration navigation

**Current seam.** Interactive configuration is split across `/settings`, `/model`, `/scoped-models`, `/login`, `/logout`, and `/trust`, each routed directly in `setupEditorSubmitHandler()` and mounted through `showSelector()`. `SettingsSelectorComponent` is searchable. `ConfigSelectorComponent` is a different resource/package editor used by the standalone `apex-code config` command; its name should not be reused for the new index.

**Architecture.** Add a small searchable `ConfigurationIndexComponent` and a `/config` slash command. Each row is a route descriptor with label, searchable aliases, description, and callback. It should close through `showSelector()` before invoking the existing handler. Do not reimplement settings, auth, model, trust, or resource writes.

Initial routes can safely include:

- Settings → `showSettingsSelector()`;
- Providers/auth → existing login/logout flow;
- Current model → `showModelSelector()`;
- Model cycle scope → existing scoped-model selector;
- Project trust → `showTrustSelector()`;
- Resources/extensions → either open the existing resource editor with its real resolved inputs or show the exact `apex-code config` command.

There is no first-class MCP configuration handler in the inspected interactive code. MCP appears only as a foreign-tool/resource concept. Do not add a dead “MCP” row. Route MCP adapters through Resources/Extensions, or implement a real MCP configuration surface as a separately specified prerequisite.

Keep all old commands canonical and working. The index is discovery and navigation, not a new persistence layer.

**Test seam.** Add `test/configuration-index.test.ts` and focused command-routing tests:

- search aliases find settings, provider/auth, model, permissions, trust, resources/extensions, and MCP adapter wording where honest;
- selecting a row calls exactly one existing handler after focus/editor restoration;
- cancel restores the editor without mutation;
- async settings/auth routes do not leave a stale selector token;
- `/config` is registered in `BUILTIN_SLASH_COMMANDS` and accepted by submit routing;
- legacy `/settings`, `/model`, `/login`, `/logout`, `/scoped-models`, and `/trust` still reach the same handlers;
- narrow/Unicode rows remain width-safe.

## Validation sequence per slice

Run the narrowest new or changed test first, then `npm run check`. After all slices, run the coding-agent suite and root `npm test`, and confirm `git diff -- packages/tui` is empty. Tests that drive a turn or write settings/session state must change to a scratch directory first, per `AGENTS.md`.
