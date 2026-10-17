# RS.8 / RS.9 candidate B: event-driven projection

Design sketch only, 2026-10-03. Read the latest G4 spec, RS.8/RS.9 plan, architect instructions/rationale/red flags, and `rs8-trace.md`; checked the SDK default selection, central loadout application, session manager append/branch seams, and settled emission in source. No implementation or tests changed. Phases: ground complete; sketch complete; synthesis belongs to root; implement/scrap pending.

## Problem

The pinned task panel combines three independently changing facts: branch-local todo data, the actual executable tool loadout, and whether a run is still active. Existing session events do not report every loadout change or ordinary todo-store writes. A genuinely event-driven projection needs authoritative notifications; attaching refreshes only to tool results and tree UI callbacks leaves idle SDK changes stale. This candidate deliberately spends more change-surface budget to make rendered frames independent of session-history scanning.

## Usage (caller's view)

InteractiveMode owns one core panel, outside extension widget maps:

```ts
const tasks = new TaskPanelController({
  expanded: settings.getTasksExpanded(),
  onChange: () => ui.requestRender(),
});
coreWidgetsAbove.addChild(tasks.component);
tasks.bind(session); // seeds projection immediately and replaces old subscription

// /tasks and app.tasks.toggle use exactly the same presentation operation.
tasks.setExpanded(!tasks.expanded);
settings.setTasksExpanded(tasks.expanded);

// Replacement/reload lifecycle: detach before invalidation; seed before extension startup.
tasks.unbind();
tasks.bind(replacementSession);

// /settings changes future-session defaults, independently of panel expansion.
settings.setDefaultTools(toggleTodo(
  settings.getDefaultTools() ?? session.getInitialDefaultToolNames(), enabled,
));
```

The controller owns normalization, display state, lifecycle, and event handling. Callers do not scan the branch, infer whether a run is finished, or inspect task statuses. The component receives only a small presentation state and renders synchronously without session access.

## Shape

```ts
type BranchMutation =
  | { kind: "append"; entry: SessionEntry }
  | { kind: "replace" }; // leaf navigation, reset/load/new file/fork mutation

// SessionManager observer, not an ExtensionContext capability.
subscribeMutations(listener: (mutation: BranchMutation) => void): () => void;

type AgentSessionEvent = ExistingSessionEvents
  | { type: "active_tools_changed" } // read current names; no copied wire payload
  | { type: "session_branch_changed" }; // read current unabridged branch

class AgentSession {
  getInitialDefaultToolNames(): readonly string[] { /* not implemented */ }
  // Existing getActiveToolNames(), subscribe(), sessionManager remain authoritative.
}

type TaskRow = Readonly<{ content: string; status: "pending" | "in_progress" | "completed" }>;
type TaskPanelState = Readonly<{
  todos: readonly TaskRow[];
  toolActive: boolean;
  runActive: boolean;
  expanded: boolean;
}>;

class TaskPanel implements Component {
  setState(state: TaskPanelState): void { /* not implemented */ }
  render(width: number): string[] { /* not implemented */ }
  invalidate(): void { /* not implemented */ }
}

class TaskPanelController {
  readonly component: TaskPanel;
  constructor(options: { expanded: boolean; onChange(): void }) { /* not implemented */ }
  get expanded(): boolean { /* not implemented */ }
  bind(session: AgentSession): void { /* seed, subscribe; not implemented */ }
  unbind(): void { /* detach, clear visible state; not implemented */ }
  setExpanded(expanded: boolean): void { /* not implemented */ }
}

function toggleTodo(names: readonly string[], enabled: boolean): string[] { /* not implemented */ }
```

All notifications occur after authoritative mutation. Listener failures must not unwind completed tool/state mutations; follow the repository's established event error semantics rather than inventing async event delivery. Notifications convey invalidation, not a second source of tool or todo truth. Equality checks avoid duplicate render requests. The manager observer is general enough to cover direct public manager mutations; limiting it to todos would leak task policy into storage. The session bridge can filter ordinary append notifications to todo entries, while leaf replacement always invalidates the branch projection.

### Exact mutation and lifecycle coverage

| Operation | Owner notification | Projection consequence |
| --- | --- | --- |
| SDK/extension `setActiveToolsByName()` | Emit `active_tools_changed` after `_applyRequestedTools()` changes actual names | Immediately hide/reveal and request a frame while idle |
| `before_agent_start` selectedTools; persistent setter inside hook | Same central application notification | Run-scoped actual executable names gate panel; never requested/default names |
| Run cleanup restores base selection; plan-mode projection; registry reload | Same central notification, deduplicated by ordered names | Tool membership follows actual runtime through both addition and removal |
| Ordinary todo store write | Manager `_appendEntry()` observer after persist; session bridges todo entry to `session_branch_changed` | Fresh complete replacement snapshot, including empty list |
| Extension/direct manager `appendCustomEntry("todo", ...)` | Same observer | No special tool-result interpretation required |
| `navigateTree()` from SDK or UI, `branch`, `resetLeaf`, `branchWithSummary` | Manager replace notification (summary path can publish after append) | Re-read latest todos on the new unabridged branch |
| Compaction | Underlying ancestor branch is retained; compaction append is not a task mutation | Panel retains tasks even if transcript/context omits their entries; lifecycle refresh may safely re-read branch |
| Session bind/resume | Controller synchronous seed via `getLatestTodos(sessionManager.getBranch())` | Correct initial branch snapshot; completed idle list immediately hidden |
| Replacement/fork/new session/switch | Before-invalidate unbind; rebind seeds replacement before extension startup | Old listeners and queued callbacks cannot overwrite replacement; captured session identity guard |
| Reload same session | Before-invalidate unbind, new registry and settings, then reseed bind | Expansion uses saved global value; actual tools preserved by existing reload policy |
| `agent_start`/`turn_start` | Existing public event sets runActive true | An all-complete task update remains visible during the run |
| `agent_end` with `willRetry` | Do not mark settled | Retry backoff retains completed panel |
| `agent_settled` | Existing public event sets runActive false | Hide all-complete list after the whole run, including abort and cancelled retry backoff |

The whole agent run, not each model/tool subturn, is the timing boundary. Empty lists hide immediately. Gating by `todo_write` also hides immediately. A non-empty all-complete list may remain only while the currently bound run is active. Bind must seed run-active state from the session's existing lifecycle authority; if no public getter supplies that fact, bind begins idle before any prompt and consumes start events, and rebinding mid-run requires a narrowly scoped lifecycle getter or an existing status getter proven equivalent. Do not infer activity solely from core-agent idleness: RS.7 found session preparation can outlive that condition.

### Rendering and composition

`TaskPanel` is a standalone pi-tui component under a dedicated core-owned above-composer container. `renderWidgetContainer()` reconstructs only the extension container. The panel uses the same mounted dock in fullscreen and main-screen; no pi-tui modifications or generic widget registry changes.

Normalize external custom-entry data once at the presentation boundary: non-array data becomes empty; invalid rows/statuses are ignored; content becomes safe terminal text with control/ANSI sequences removed and newlines converted to spaces. Retain only schema-valid domain rows. Rendering truncates by terminal width with existing public helpers, never character slicing. Collapsed state is one line with completed/total and first in-progress text. Expanded state is at most five single-line rows plus one overflow line. Width 0/narrow widths must remain bounded and well formed. Snapshot normalization is cached between mutations, not repeated per streamed token.

Add a renderer-only `todo_write` entry to `core/tools/renderers/index.ts` so execution/typebox code stays out of display imports. `renderCall` supplies the terse task label; successful `renderResult` supplies `Task list updated · N/M complete` without duplicate headings. Use typed details only after presentation validation. Error result preserves actual text and styling. Expanded rendering uses the existing disclosure context; Ctrl+O and per-call mouse behavior remain governed by ToolExecutionComponent. Test actual composed rows, not renderer functions alone.

### Defaults and controls

SDK computes `defaultActiveToolNames` from core `read`, `bash`, `edit`, `write` plus configured LSP, web search, and MCP. Capture that original list into session config before explicit `tools`, `excludeTools`, `noTools`, hooks, or saved defaults alter actual execution. `getInitialDefaultToolNames()` exposes a copy for the future-default settings row; it must not return current active names or all registered tools. This extra accessor is a cost of honest defaults and can be avoided if an existing settings context already carries the original list.

`SettingsManager.setDefaultTools(names)` follows global mark/save; preserve unrelated names/order and do not discard configured tools on the first toggle. Row enabled state uses effective configured defaults, or captured original defaults when unset. Project `defaultTools` takes precedence: show that source and avoid pretending a shadowed global edit changed effective defaults. Prefer making that row read-only with a project-override explanation while project defaults are active, rather than unexpectedly writing project JSON. Toggling updates future sessions only; current session/loadout and restrictive CLI registry ceilings stay authoritative. Reload is not a new session and preserves the current requested selection.

Add `/tasks` to built-in command registration and dispatcher. Add `app.tasks.toggle` to app keybindings, editor action registration, and extension reserved-shortcut handling. Alt+J is a candidate only after an effective-key collision test against pi-tui defaults; record the selected Meta requirement in spec/docs. Expansion persists globally independently of todo enablement.

## Module map

| Module | Knowledge owned |
| --- | --- |
| `core/session-manager.ts` | Mutation observer; append/leaf/load semantics, no task UI policy |
| `core/agent-session.ts` | Actual tools change notification; bridge branch invalidation; captured SDK original defaults |
| `core/sdk.ts` | Original configured default selection handed into session config |
| `components/task-panel.ts` | Defensive domain presentation, bounded rows, expansion and lifecycle projection |
| `interactive-mode.ts` | Core widget composition, runtime bind/unbind, commands/keys/settings callbacks |
| `core/tools/renderers/todo-write.ts` and renderer index | Compact result display and existing disclosure |
| `settings-manager.ts`, settings-selector | Global expansion and initial-tool default preference |

This shape is deep at the UI boundary: three bind/toggle operations hide branch interpretation, schema normalization, activity lifetime, and tool membership. The storage/session observation surface is larger than the visual feature alone; avoid a general UI event bus or stage-by-stage refresh methods. Red-flag screen: no storage schema exported into widget API, no extension map ownership leakage, no shallow refresh/validate/load wrappers, no pi dependency patch.

## Synthesis decision

Pending root comparison with candidate A. Prefer this candidate only if immediate frame requests for idle SDK setters and raw manager branch mutations are required. Otherwise adapt the central tools notification and standalone bounded component, but choose a smaller branch-pull/cached projection that avoids adding manager-wide observer semantics.

## Tradeoffs accepted

- We accept two new session event variants plus a manager observer in exchange for authoritative idle refresh and no branch scans during streaming frames.
- We accept storage mutation notifications in forked code in exchange for covering direct public manager writes/branch changes; this carries real upstream merge cost under ADR 0003.
- We accept whole-run completed timing in exchange for avoiding disappearance during automatic retries; the spec should make the run boundary explicit.
- We accept a saved-default control that does not change this session in exchange for preserving existing CLI and reload authority.

## Alternatives considered

- Live render getter: hides branch synchronization and directly follows current branch/tools, with no added events, but incurs branch reads and does not cause an idle SDK setter to request a frame. Cache by session+leaf can reduce work but still needs a frame trigger.
- UI-event-only cached snapshot: keeps session APIs smaller but leaks lifecycle knowledge into InteractiveMode and misses direct SDK navigation/manager writes; not sufficient for the full correctness envelope claimed by this candidate.
- Render transcript details as tasks: small plumbing but duplicates persistence interpretation and loses tasks removed from model context by compaction; rejected.

## Open questions and risks

No human decision is required for this sketch. Does the existing public session lifecycle getter cover preparation/retry activity sufficiently to seed a mid-run rebind? If not, the event design needs one more narrowly scoped getter, increasing its cost. Do raw SessionManager mutations need immediate idle redraw, or only correct next-render state? That scope choice determines whether the manager observer is justified. Can global settings rows already express a project override without inventing new selector metadata? Confirm existing settings-source conventions before implementation.

## Verification and next implementation step

First write failing public-boundary tests for mounted task component and actual session/mode lifecycle: idle SDK setter, hook run selection/cleanup, branch/resume/compaction, replacement stale callbacks, completed retry timing, corrupt/ANSI/multiline/narrow input, empty list, extension widget updates, expansion persistence, real tool cell errors/disclosure. RS.9 tests must drive the actual settings row, preserve original core/configured defaults and custom selections, prove future-session behavior, and cover project override plus CLI ceilings. All session/turn tests use scratch cwd.

Benchmark must mount the actual task component inside the production dock, not merely rerun the existing transcript-only scenarios. Compare identical no-panel and panel workloads baseline/head back to back on an idle host using the runtime tsconfig; include large branch history to expose scan cost, narrow terminal, and expanded panel. Keep untouched control scenarios to distinguish uniform contamination from feature cost. Run narrow relevant files, tsgo, then npm test/npm run check once for the completed slice. No verification has been run by this design candidate.
