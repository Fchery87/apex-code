# RS.7 candidate A

## Recommendation

Keep the requested tool loadout separate from the effective tool loadout. Project
the requested names plus the one mode-owned tool at synchronization boundaries.
`plan_present` remains an ordinary contract-bearing tool; activation does not
reclassify its permissions or grant authority to extensions.

The latest spec defines a session-owned injected presenter and three decisions.
The current session already owns permission-mode setters, extension UI bindings,
runtime registry construction, and next-request prompt projection. These are the
right owners. Do not add an extension-context permission setter.

## Tool and presenter boundary

```ts
export type PlanDecision =
  | { approved: true; nextMode: "acceptEdits" | "default" }
  | { approved: false };

export interface PlanPresenter {
  present(plan: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<PlanDecision>;
}

createPlanPresentToolDefinition(presenter: PlanPresenter = defaultPlanPresenter)
```

The optional signal preserves simple two-argument injected implementations and
passes existing tool cancellation to `ctx.ui.select(..., { signal })` through the
existing `ExtensionUIDialogOptions` seam. It is preferable to a separate per-call
presenter registry or lifecycle API. The default presenter rejects headless use
with the existing error. In UI sessions
without an owning AgentSession it selects the same three choices and returns the
typed decision, without a permission mutation. The session injects a presenter in
`_buildRuntime` beside its injected todo store. Tool execution only calls the
presenter and maps the decision into content and details. Details are a union or
keep backward-compatible `approved: boolean` plus optional `nextMode`; evidence
adds `nextMode` only for approved decisions. `WorkflowEvidenceRecord.nextMode`
should use the same narrow `"acceptEdits" | "default"` type.

Select displays the plan in the title/body supported by the existing select API,
then exactly `Yes, and accept edits`, `Yes, and ask before each edit`, and
`No, keep planning`. Undefined selection means rejected. The session validates
that its current UI binding and lifecycle generation still match before applying
the interactive override. The presenter captures `_interactivePermissionModeGeneration`
before opening the selector and checks it after resolution, so concurrent cycling,
clear, or reload invalidates the old decision. Check signal.aborted at both points.
After awaiting `setInteractivePermissionMode`, confirm the returned resolution is
the requested mode with interactive origin before returning approved. Setter errors
remain errors; stale or ineffective changes return rejected. Only the injected
session implementation calls `setInteractivePermissionMode`.

The schema still has only `plan`. The caller cannot choose `nextMode` as an
argument. Preserve the existing contract unchanged except evidence enrichment.

## Requested loadout and projection

```ts
private _requestedActiveToolNames: string[] = [];
private _permissionToolsGeneration = 0;
private _effectivePermissionMode?: PermissionMode;

private _projectActiveToolNames(requested: readonly string[]): string[] {
  // Dedupe and validate against the runtime registry here.
  return this._effectivePermissionMode === "plan"
    ? [...new Set([...requested, "plan_present"])]
    : [...new Set(requested)];
}

private async _synchronizePermissionTools(): Promise<void> {
  const generation = ++this._permissionToolsGeneration;
  const mode = await this._permissionGate?.getMode();
  if (generation !== this._permissionToolsGeneration) return;
  this._effectivePermissionMode = mode;
  this._applyToolLoadout(this._projectActiveToolNames(this._requestedActiveToolNames));
}
```

`_applyToolLoadout` assigns executable tools and rebuilds base prompt options.
`setActiveToolsByName` updates requested names and invokes the synchronous
projection using the last synchronized mode. It must not infer explicit intent
from `getActiveToolNames()`, because that contains the automatic addition. Runtime
registry refresh and reload carry forward requested names, not projected names.
Transcript restore similarly sets the requested loadout; where historical
transcripts cannot distinguish provenance, preserve a listed tool as requested.
That is a compatibility choice, not a new persistence format.

When approval changes mode, synchronizing against the same requested names removes
only the automatic `plan_present`. A user-listed `plan_present` remains. An
extension's explicit `setActiveTools` request is explicit requested intent too.
`before_agent_start` selectedTools mutations need the same rule: if unchanged use
requested names; if changed use the edited list as requested input, then apply the
mode projection. Never replace requested names with a projected list while doing
ordinary prompt refresh.

## Effective mode and asynchronous construction

Use the existing gate's `getMode()` for activation. `getPermissionMode()` currently
projects flag and store sources and does not necessarily reflect a custom getter
or delegated parent fallback. Recomputing effective mode from those sources would
make child tools disagree with authorization. No additional permission
classification or permission-store resolver belongs in this feature.

Construction is synchronous, but a configured getter may be asynchronous. Seed
the startup projection from the existing captured startup promise when it resolves,
with a guarded generation and explicit rejection handling. Do not install an
unhandled detached rejection. SDK `createAgentSession` should await a narrow
session initialization/synchronization promise before returning, so callers see
the startup plan tool immediately. Direct constructor users must synchronize on
their first asynchronous public boundary, particularly `bindExtensions`, `prompt`,
and next-response preparation. Startup snapshot remains the bypass ceiling;
subsequent synchronization reads the live getter.

Await synchronization after `setInteractivePermissionMode`, `setPermissionMode`,
and successful runtime rebuild/reload; at `prompt` before before_agent_start; and
in `_installAgentNextTurnRefresh` before selecting tools. These last two refreshes
cover external permission-file edits and live delegated parent fallback. Clear is
currently synchronous: invalidate pending reads immediately, remove the cached
interactive mode, and start a guarded refresh; reload and prompt must await the
refresh before using the loadout. Avoid silently changing clear's public signature
without migrating its callers and tests.

## Allowlist and suppression policy

Current CLI `main.ts:559` passes parsed tools into SDK `tools`, and SDK maps that
to `_allowedToolNames`. Registry construction drops unlisted definitions. Merely
appending an active name cannot make approval reachable under `--tools read`.
Delegation also passes its ceiling-checked admitted tool names through SDK `tools`
and records them in the child policy snapshot. Therefore the registry eligibility
ceiling must remain authoritative, including allowed names, excluded names, and
no-tools. Never add a mode exception to `isAllowedTool`.

Smallest recommended policy: automatic activation occurs only when the existing
registry admits `plan_present`. Qualify the spec activation sentence accordingly,
and test `--tools read` and `--exclude-tools plan_present` as suppressed while
`--tools read,plan_present` remains explicitly active after leaving plan mode.
DefaultTools controls active selection and does not restrict the registry, so it
supports automatic activation normally. SDK and delegated-child ceilings stay
intact without a new option or a distinction inferred from tool names.

If unconditional CLI activation under --tools is desired, make it a separate CLI
mapping decision and separate the initial requested active list from the allowed
registry list. Appending plan_present to SDK `tools` alone would mark it explicitly
active outside plan mode and widen the delegation ceiling, so it is incorrect.
That broader API change is unnecessary for the recommended RS.7 slice.

## Approval cancellation and TUI refresh

Capture a session-owned presenter/UI binding generation, incremented on reload,
dispose, and UI rebind. Check it around the selector and before applying mode.
Capture the existing interactive-mode generation too, avoiding new mode-version
state. AbortSignal propagates tool cancellation into the selector and avoids an
indefinite modal while abort waits for idle. Return rejected or throw abort on stale
completion; never report approved evidence after no mode transition.

`setInteractivePermissionMode` already has a startup-await generation guard, but
presenter invalidation must also reject an approval whose dialog outlives an abort
or session swap. Session swap calls abort/dispose on the old session or explicitly
invalidates its presenter bindings; root should verify the runtime-host path.

After a real approval, the session emits a permission-mode-changed event with the
effective resolution and the TUI refreshes the existing footer through its normal
session event handler. This is preferable to invoking arbitrary extension status
text or waiting until turn end: approval can be followed by tool calls in the same
run. The TUI event handler must capture its bound session identity so old-session
events cannot repaint the replacement footer.

## Public tests

1. Tool boundary covers default headless rejection, all three choices, dismissal,
   presenter injection, exact approved details and additive evidence nextMode.
2. Real scratch SDK sessions cover startup flag/file plan, defaultTools explicit
   plan_present, --tools explicit inclusion and authoritative no-tools/exclusions.
3. Mode transitions prove automatic add/remove and retained explicit inclusion,
   with request context and system selectedTools matching executable tool names.
4. Live delegated child and custom async getter prove activation follows the gate,
   including mid-run next-response preparation.
5. Pending selector after abort, reload, rebind, or disposal cannot transition mode
   or record approved evidence. Pending mode reads cannot reinstate stale tools.
6. Interactive boundary drives the registered plan tool through real UI select,
   checks the resulting override and footer marker, then checks the next request's
   tools. All tests writing sessions run from scratch directories.

## Tradeoff

Requested versus projected state is more deliberate than a single boolean
auto-added flag, but the extra state captures actual domain intent. It prevents
reload, prompt refresh, and explicit setActiveTools from accidentally making an
automatic addition permanent or deleting an explicit tool. The cost is migrating
each loadout-writing seam to one owner and qualifying restrictive loadouts.
