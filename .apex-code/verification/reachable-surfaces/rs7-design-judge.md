# RS.7 design judgment

Read both candidate artifacts fully after candidate B completed and candidate A
confirmed its final revision. This is design review, not implementation validation.

## Verdict

Use candidate A's requested-loadout projection as the base. Graft candidate B's
existing `tool_execution_end` footer refresh. Keep the optional third presenter
AbortSignal and both lifecycle/UI and mode-generation guards. Neither candidate
justifies a permission-mode event or an exception to registry restrictions.

| Rubric | A | B | Judgment |
| --- | --- | --- | --- |
| Mode and tool-selection owner, minimal API | Session owns requested intent and projects effective tools | Session owns one implicit-add boolean beside effective tools | A is clearer and idempotent; B has fewer fields but requires provenance discipline at every internal setter |
| Explicit selection and restrictions | Preserves requested intent and registry allow/exclude ceiling | Preserves intent if internal writers never promote the implicit tool | A is stronger across reload; both correctly reject allowlist exceptions |
| Startup, request, retry, reload, transcript | Explicit async initialization and request-boundary synchronization | Same synchronization, plus ownership preservation across internal writes | A better expresses state; both require tests of all executable-loadout writers |
| Stale and cancelled approval | Signal plus binding/lifecycle and existing mode-generation checks | Same checks, explicit verification of setter resolution | Final A includes B's useful guards; retain both checks before and after awaited mutation |
| Public boundary tests and UI | Strong matrix, proposes a new event | Strong matrix, refreshes existing tool-result handler | Prefer B's smaller UI seam and real next-provider-request proof |

## Defects and decisions to settle in implementation

- Do not blindly record projected names as requested names. Registry refresh,
  reload, request preparation, and transcript restoration all currently write the
  active set. A helper used only by `setActiveToolsByName` leaves multiple owners.
- A's historical-transcript preservation is an explicit compatibility choice.
  Historical entries cannot establish whether `plan_present` was automatic. New
  sessions should not persist a new provenance field or derive a session mode
  override from transcript tool names.
- Before-agent-start tool edits are normally scoped to a run. Preserve that scope
  when projecting a hook-edited list; do not accidentally turn the edit into a
  permanent requested selection. Explicit `setActiveTools` remains persistent
  session intent as today.
- B discusses plain CLI `--no-tools` as possibly retaining registry eligibility.
  Actual `main.ts:554` maps it to SDK `noTools: "all"`, which makes the allowlist
  empty. SDK `noTools: "builtin"` is the distinct case and disables default tools
  while keeping the registry. Qualify and test those existing semantics precisely.
- Use the wrapped gate getter for activation, including custom SDK getters and
  live delegated-parent fallback. Store-only origin projection is not the same
  authority. Check current generations after awaited getters.
- A's new permission-mode event adds an unnecessary public surface for RS.7. A
  successful `plan_present` tool-result event can use the existing session-safe
  footer refresh before displaying the new state. Test stale-session resolution.
- A gate-less session cannot report that it successfully applied a session mode.
  Decide that behavior explicitly. Recommended session-owned behavior is a clear
  failure when approval cannot apply the override; standalone injected presenters
  may continue returning decisions without owning authorization. Never emit an
  approved effective-mode record after an ineffective or stale mutation.
- Avoid unconditional detached activation synchronization in construction that
  can reject without a handler or race newer explicit intent. Await the SDK
  initialization seam, and synchronize direct constructor users at their first
  asynchronous request/binding boundary.

## Minimum proof

Use scratch sessions for startup flag/file/custom getters; implicit activation
and removal; explicit defaultTools/tools retention; allow/exclude/no-tools
ceilings; saved mode edits; reload and transcript restoration; custom and child
live getters; selector abort/rebind/reload/dispose/newer cycle; and no persisted
mode state. Drive the actual interactive selector and tool-result handler, then
inspect a real continuation provider request for consistent executable tools,
schemas, and system prompt. Tool tests must preserve old evidence shapes while
adding `nextMode` only when present.
