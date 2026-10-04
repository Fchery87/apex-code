# RS.8 / RS.9 candidate A: pull-based core panel

## Problem

Todo snapshots already live in the unabridged current session branch. The missing UI must follow branch/session changes, survive extension widget replacement, obey the actual active loadout, and stay cheap during streaming. Existing public events omit ordinary todo persistence, tree changes, and idle active-tool setter changes. Adding an observer contract solely for composer chrome increases the fork surface. Settings must save a future-session default without accidentally copying the current CLI/hook selection or dropping configured search/LSP/MCP defaults.

Grounded in `rs8-trace.md`, spec G4, live plan RS.8/RS.9, the architect skill, its rationale template, and design-red-flags checklist. Source checks confirmed SDK owns configured implicit defaults, SessionManager exposes `getLeafId()`, and renderer registry already supplies built-in presentation overlays.

## Usage (caller's view)

```ts
// InteractiveMode owns this core child, separately from disposable extension children.
const tasks = new TaskPanelComponent({
  getSession: () => this.session,
  settings: this.settingsManager,
});
coreAboveComposer.addChild(tasks);

// Forward only lifecycle events from the already installed subscription.
tasks.handleEvent(event); // agent_start / agent_settled; other variants ignored
// /tasks and resolved app.tasks.toggle call the same operation.
tasks.toggle();
this.ui.requestRender();

// Settings displays a future-session preference, not current tool activation.
const defaults = this.settingsManager.getDefaultTools() ?? this.session.getImplicitDefaultToolNames();
selectorConfig.taskListTool = defaults.includes("todo_write");
onTaskListToolChange(enabled) {
  const current = this.settingsManager.getDefaultTools() ?? this.session.getImplicitDefaultToolNames();
  this.settingsManager.setDefaultTools(enabled
    ? [...current.filter(name => name !== "todo_write"), "todo_write"]
    : current.filter(name => name !== "todo_write"));
}
```

## Shape

```ts
// New modes/interactive/components/task-panel.ts; internal UI surface only.
interface TaskPanelOptions {
  getSession(): AgentSession;
  settings: SettingsManager;
}
class TaskPanelComponent implements Component {
  constructor(options: TaskPanelOptions); // not implemented
  render(width: number): string[];        // not implemented
  invalidate(): void;                     // not implemented; layout/theme cache only
  toggle(): void;                         // not implemented; persists global preference
  handleEvent(event: AgentSessionEvent): void; // not implemented; owns turn-retention latch
}

// Small existing SettingsManager additions, normal markModified/save pattern.
interface Settings { taskPanelExpanded?: boolean; }
getTaskPanelExpanded(): boolean; // false when unset
setTaskPanelExpanded(expanded: boolean): void;
setDefaultTools(names: string[]): void; // defensive copy; existing global setting semantics

// Additive data projection, no new session event or runtime authority.
interface AgentSessionConfig { implicitDefaultToolNames?: readonly string[]; }
getImplicitDefaultToolNames(): string[]; // copy of construction defaults before CLI ceilings

// Existing display registry extension, renderer-only module.
export const todoWriteRenderers: ToolRenderers;
// app.tasks.toggle defaults to alt+j and joins extension-reserved effective actions.
```

**Panel ownership and cache.** The component obtains the live session each render. Cache the normalized snapshot by AgentSession identity, SessionManager session ID, and current leaf ID. `getBranch()` and `getLatestTodos()` run only when that key changes; streaming deltas with an unchanged leaf reuse the cache. Persisted full replacement, direct appendCustomEntry, navigation, resumed sessions, compaction, and replacement all either change the key or acquire a new live session. Cache an owned, normalized copy; do not retain raw mutable session data. In-place mutation of a previously appended custom-entry object is not a supported task update; the task storage contract is append-only full snapshots. Explicitly test appended empty snapshots. Invalid data produces no invalid rows: require an array, string content, and one supported status per row at this presentation boundary.

**Loadout gate.** Each render cheaply tests `session.getActiveToolNames().includes("todo_write")` before emitting rows. Do not use settings, registration, or requested tool intent as activation. This correctly reflects persistent SDK setters and temporary hook selection on the next frame. The existing setter does not schedule a TUI frame; promise visibility on the next requested render, not immediate unsolicited redraw while idle. No polling timer and no new session event. Interactive action and known lifecycle paths already request frames.

**Completed timing.** Panel owns a turn-active latch set by `agent_start` and cleared by `agent_settled`, so a retry's intermediate `agent_end` does not hide completed tasks. A complete snapshot written while that same turn is active remains visible until settled. Loading/rebinding an already complete branch while idle hides it immediately. Rebinding resets the latch and retention before reading the new branch. Use latest todo entry ID alongside the normalized snapshot to distinguish a newly completed replacement from an old already-complete list when a later turn starts. Failed/no-op calls cannot create completion retention. All tool success/error events request existing frames; the next render reads durable state rather than result text.

**Rows and bounds.** Collapsed: one sanitized terminal line `Tasks N/M · <first in-progress content>`; if no in-progress task, count alone avoids inventing active status. Expanded: five single-line items using distinct glyphs, plus one `+N more` line. Strip ANSI/control sequences and normalize line breaks before terminal-column truncation. Width-zero and narrow terminals must not throw or emit lines wider than available width. Put any shared task normalization/counting in the renderer-only task display module if both component and renderer need it; do not import executable tool/typebox modules at runtime merely to render data.

**Core chrome.** Keep `widgetContainerAbove` as composed ownership: core task child/subcontainer plus the existing extension-only container. `renderWidgets()` clears only extension children. Main-screen and fullscreen mount the same core composition; dock shrink rules still cap short-terminal chrome. Do not broadly refactor InteractiveMode or pi-tui. Component height is bounded independently of extension widget limits.

**Compact todo cell.** Add `todo_write` to `RenderedToolName` and the existing registry. Render one compact success line, not a duplicated call label plus result summary. While pending use a sensible call label. Expanded result discloses all snapshot details through existing per-call/Ctrl+O behavior. Error context displays actual tool error content and never says “Task list updated.” Extension-provided renderers retain precedence.

**Saved defaults.** SDK passes its already computed `defaultActiveToolNames` into the optional construction projection before applying `settings.defaultTools`, explicit `tools`, `excludeTools`, or `noTools`. This small additive getter separates configured implicit defaults from live/CLI authority. Low-level AgentSession construction without the optional field derives its own construction-config defaults using the existing core four and configured transports, with custom base-tool override handled explicitly. Avoid deriving configured services from registered names because unconfigured tools remain registered. Saved explicit arrays preserve names/order except todo additions/removal. Do not change current active tools, reload preservation, exclusions, or restrictive registries. Label the settings control as applying to new sessions; project settings use existing precedence and may shadow global edits. Surface that shadowing through the existing settings feedback seam rather than claiming the effective value changed.

Interface depth: one component owns snapshot validation, caching, live activation, bounded rendering, persistence, and turn timing; callers own only placement and existing event forwarding. No public event protocol, branch-state DTO, or multi-stage controller pipeline leaks into InteractiveMode.

## Synthesis decision

Candidate only; root arena judge fills the final decision. Recommend this pull-based shape as the base because it covers silent branch/loadout changes without adding lifecycle producers to AgentSession. Adopt any competing candidate's sharper renderer or settings tests without adopting its observer API.

## Tradeoffs accepted

- Accept next-frame visibility after idle SDK setter changes in exchange for no new event, polling loop, or scheduler coupling.
- Accept one backward branch scan per new leaf in exchange for correctness on direct append/tree/compaction without a brittle list of refresh calls; unchanged streaming frames are constant-cost.
- Accept a narrow additive default-name getter/config field in exchange for preserving configured services without copying current CLI ceilings into persistent defaults.
- Accept global expansion and existing project/global default precedence instead of introducing per-session preferences or a new settings override system.

## Alternatives considered

**Event-driven TaskPanelController.** Centralize a new `active_tools_changed` producer at `_applyRequestedTools`, a branch revision producer at every custom append/navigation/rebind, and push snapshots into a pure renderer. It hides render-time session reads but exposes new public event completeness and synchronization requirements across ordinary tools, direct manager callers, hooks, retries, reload, and extensions. Its renderer is simpler while its cross-layer contract is larger. Prefer it only if immediate idle redraw is a product requirement; G4 does not require that timing.

**Seam-only refresh.** Read snapshots on todo success, load, and interactive tree adapters, then render cached rows. Smallest initial code but wrong for direct SDK navigation/custom append and idle loadout changes; callers must know every invalidation cause, a shallow interface with temporal decomposition.

## Open questions and risks

No human decision is required for this candidate. Verify whether `agent_start` occurs after hook-selected tools are applied; render-time gating still governs every frame. Verify core chrome on a short fullscreen terminal and project-shadowed settings feedback through real mounted boundaries. If persistent custom entries explicitly support in-place mutation, the leaf-key assumption must be replaced with a real revision contract before implementation, not a render-time deep fingerprint.

## Next implementation step

Write failing mounted/component tests for live session/branch/loadout changes, completed retention across retries, and extension widget replacement, then implement the standalone component before command/key and settings integration.

## Validation contract

Public/component tests cover collapsed counts, in-progress name, five rows/overflow, corrupt data, empty replacement, narrow width/Unicode/control text, direct branch append/navigation/resume, pre-compaction snapshot, replacement session, active/no-active todo including hook cleanup, and all-complete retention through retry then settlement. Mounted ToolExecutionComponent tests cover compact success, disclosure, and real errors. Real settings selector tests verify untouched default, all core/configured service defaults on first enable, custom arrays and disable, new-session effect, current-session stability, explicit CLI/exclusion/noTools ceilings, project precedence, and expansion round-trip. Effective action collision tests assert Alt+J through platform/key parsing and extension reservation; document terminal Meta/Option handling. Bench a production dock with mounted panel collapsed/expanded and unchanged leaf under streamed deltas, using identical baseline/head scenarios back to back on an idle host; unchanged transcript-only scenarios detect contamination but cannot prove panel cost alone. Run focused red/green loops, tsgo, full npm test/check only after the verified slice is frozen.
