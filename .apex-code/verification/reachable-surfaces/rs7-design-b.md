# RS.7 alternative B: Own the implicit plan tool separately

This is a design candidate, not an implementation or a validation result. Grounded in the current 2026-10-03 spec and plan, `AgentSession`, the SDK tool selection, `plan-present.ts`, the workflow evidence contract, and the interactive tool-result handler. No outside source was consulted.

## Shape

Keep the existing live active-tool array as the main state. Add one session-owned fact saying whether Apex added `plan_present` because of plan mode. Reconcile only this one tool at mode resolution boundaries. Do not introduce a new complete requested-loadout state.

```ts
type PlanDecision =
  | { approved: true; nextMode: "acceptEdits" | "default" }
  | { approved: false };

interface PlanPresenter {
  present(plan: string, ctx: ExtensionContext): Promise<PlanDecision>;
}

interface PlanPresentDetails {
  plan: string;
  approved: boolean;
  nextMode?: "acceptEdits" | "default";
}

// Session fields
private _ownsImplicitPlanTool = false;
private _planToolSyncGeneration = 0;
private _planPresentationGeneration = 0;

// Important separation: public setters describe user/extension intent;
// private writers apply a computed loadout without changing its ownership.
private _applyActiveToolsByName(names: string[]): void;
private _reconcilePlanTool(mode: PermissionMode | undefined): void;
private async _syncPlanToolMode(): Promise<void>;
```

`_reconcilePlanTool` checks that the registry contains `plan_present`. In plan mode, if absent, append it and mark ownership true. Outside plan mode, remove it only if ownership is true, then clear ownership. When already present and ownership is false, retain it permanently across mode exits.

A public `setActiveToolsByName(names)` is explicit intent. If names includes `plan_present`, clear implicit ownership before applying it; otherwise apply names and then reconcile the last resolved effective mode. An extension selecting tools explicitly can make an implicit tool explicit. A replacement loadout in plan mode still gets `plan_present` appended if available.

The private registry refresh must retain ownership while carrying the effective loadout forward. It must not call the public setter, which would accidentally promote an implicit tool into an explicit one. Likewise reload must pass the previous live set to the private path and preserve `_ownsImplicitPlanTool` until it has reconciled the cleared mode. This is the main advantage and main fragility of this alternative.

## Actual mode and asynchronous construction

Use `_permissionGate.getMode()` for activation, not the store-only source projection in `getPermissionMode()`. The wrapped gate getter already includes the RS.5 override and preserves a custom SDK mode getter. No gate means no implicit tool, while an explicitly active tool may still present a plan through the bound UI and return a decision without inventing a permission layer.

Constructor setup is synchronous but startup mode may be asynchronous. After `_buildRuntime` and transcript restoration, schedule `_syncPlanToolMode()` with a generation check and a handled rejection. The SDK should await a small session initialization seam before returning, or await the reconciliation through an existing initialization path; this makes the active set immediately correct after `createAgentSession` resolves. Direct `new AgentSession` consumers cannot be promised synchronous correctness for an unresolved custom getter. Every first request must independently await synchronization before selecting tools.

Run synchronization before the `before_agent_start` snapshot and before `prepareNextTurnWithContext` rebuilds the request. This observes saved-file changes and live custom getters. `setInteractivePermissionMode` reconciles synchronously after installing a successfully authorized override. `setPermissionMode` awaits synchronization after the saved write. `clearInteractivePermissionMode` remains synchronous for RS.5 compatibility: invalidate pending reads, clear state, and launch handled asynchronous reconciliation. Callers that require a finished loadout, including reload and request preparation, await the reconciliation. A mode getter failure must not be silently turned into a guessed plan-mode decision.

`_syncPlanToolMode` increments a generation, awaits the actual gate getter, and changes nothing if a newer synchronization or override won. Do not have it recursively call `getPermissionMode` if that method itself triggers synchronization.

## Registry restrictions

The registry is the authoritative availability boundary. `--tools read` currently becomes `allowedToolNames`, so `plan_present` is not registered. Preserve that explicit allowlist and `excludeTools`: plan mode cannot resurrect an unavailable tool. `--tools read,plan_present` and `defaultTools` containing `plan_present` make it explicit, so leaving plan mode retains it. `--no-tools all` excludes it entirely. Plain `--no-tools` currently means no initially active tools, not an empty registry; the spec should clarify whether plan-mode activation is allowed in that case. Strong recommendation is respect the explicit no-tools request and test it, rather than silently enabling a tool after the user disables all defaults.

Registry refresh must not confuse a rewrapped same-name tool with a new explicit activation. When an extension overrides the built-in name, the registry's winner remains the winner; introducing a separate classification or bypassing wrapping would break existing extension contracts.

Transcript-restored loadouts have no provenance for an old implicit `plan_present`. Treat them as explicit legacy selections or define a deliberate migration, rather than inferring ownership from a name alone. SDK-created sessions usually supply initial tool names already; direct sessions and resume tests still need coverage. Ownership is session memory and must not add a persisted schema.

## Presenter and cancellation

The tool factory takes an optional presenter. Its default retains the existing headless error and uses the same three-way select when UI exists. The injected session presenter renders the plan using existing UI chrome and asks the three options exactly as the spec states. Rejection and dismissal return `{ approved: false }` without `nextMode`.

The injected presenter snapshots the session presentation generation and the current interactive mode generation before awaiting select. Reload, disposal, abort, or UI rebind invalidates it. After select, confirm the captured UI context still owns the session. A late approval from an obsolete dialog must not set a mode or report approval. A user cycle while the dialog is pending is another stale response and should invalidate approval, so it cannot overwrite the more recent mode.

The spec's exact `present(plan, ctx)` shape does not carry an AbortSignal. Strong recommendation is add optional `signal?: AbortSignal` to `present` and forward execute's signal to `ctx.ui.select(..., { signal })`. This is additive for implementers with the existing two arguments and makes the tool cancellation boundary reliable. Check `signal.aborted` after select and after the awaited setter. The setter's existing generation check protects a clear/reload during its startup await; the presenter must additionally check that the returned effective mode equals the requested approved mode before returning approval.

A gate-less SDK session must not falsely report a mode switch. Recommended behavior is allow approval as a workflow decision without a transition because no permission gate exists; document and test this distinctly. If the product instead requires every approval to switch modes, fail clearly when the setter returns undefined. Do not silently conflate these cases.

Use the existing tool contract. Add optional `nextMode` to workflow evidence only when present in details; reject/cancel records retain today's shape. Do not persist the interactive override.

## Interactive refresh

After successful `tool_execution_end` for `plan_present`, the real interactive handler calls the existing footer permission refresh and render path. That method already checks session identity; retain that guard across its await. An explicit mode-changed session event would also work but is a larger public surface. A tool-result refresh is the smaller RS.7 change. Test the actual event handler and registered built-in tool, not just a fake presenter decision.

## Tradeoffs and recommendation

This candidate minimizes broad active-loadout changes and preserves all existing public setters. Its cost is provenance discipline: every internal path that feeds the current effective set back into a setter can accidentally promote the implicit tool into an explicit tool. Today registry refresh calls the public setter, reload passes `getActiveToolNames`, transcript restoration directly writes the agent, and prompt extensions can edit selected tools. All must be audited.

A requested-set projection is stronger when more mode-dependent tools are likely, because intent and the effective set are explicit and recomputation is idempotent. For exactly one tool, ownership can be a smaller patch, provided the internal/private writer split is rigorously maintained. My recommendation is choose requested-set projection if candidate A has a bounded implementation that updates registry refresh and prompt projection together. Choose this ownership alternative only if its smaller diff is material; do not keep two competing active-loadout authorities.

## Precise boundary test matrix

All SDK/session/turn tests run in scratch cwd and use scratch settings/session/evidence stores.

| Boundary | Required cases |
| --- | --- |
| Tool factory | Injected acceptEdits/default decisions yield approved plus exact nextMode; reject and dismissal omit nextMode; default presenter uses exact three labels and renders supplied markdown; no UI and no context throw existing headless error; custom injected headless presenter can operate without the default UI check; aborted signal cannot produce approval. |
| Contract/evidence | Same four-axis contract and undeferred schema; approval evidence adds nextMode; old approved-only result and rejection retain identical old record shape; no unknown fields in permission rules. |
| Startup | Flag plan and file plan activate before awaited SDK creation returns; deferred custom getter resolving plan does the same; custom getter default with file plan does not activate; getter rejection is controlled and not unhandled. |
| Session mode | Default to plan appends once; plan to default/acceptEdits removes only owned tool; repeated reads and cycles do not duplicate; explicit initial/defaultTools plan_present survives exits; public setter includes it while implicit then exits retains it; setter excludes it during plan re-adds implicitly. |
| Restrictions | Explicit --tools without plan_present, excludeTools, and no-tools-all preserve registry exclusion; explicit --tools containing it retains it on exit; settle plain --no-tools behavior before assertions. |
| Runtime | Registry refresh and reload do not promote owned tool; saved file mode and live SDK getter changes are reflected on next actual provider request; first provider request gets consistent system prompt/schema/tool list; approval continuation request no longer advertises implicit plan_present. |
| Resume | Explicit configured plan_present survives; unconfigured default resume in plan activates; resume outside plan does not invent ownership from a legacy transcript without a stated policy; session context entries unchanged before a request. |
| Approval | All three choices drive the registered session tool; acceptEdits/default beats saved/flag plan with interactive origin; rejection/dismissal leaves mode and set intact; actual edit gate changes after approval; saved permissions/settings/session files receive no mode write; gate-less behavior is explicit. |
| Staleness | Pending select followed by reload, disposal, UI rebind, abort, or a newer cycle cannot change mode; pending setter startup await followed by clear/reload cannot approve; stale synchronization cannot remove a newly explicit tool. |
| Interactive | Real tool_execution_end repaints footer with new mode/session marker; stale old-session footer resolution cannot repaint replacement; failed tool result leaves existing mode; default choice order is visible in the real selector. |
