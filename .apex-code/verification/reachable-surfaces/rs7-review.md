# RS.7 independent correctness review

Reviewed the frozen RS.7 production diff against `/tmp/apex-rs7-baseline`, including
public exports, prompt snippet, requested/effective loadouts, tool evidence,
presenter cancellation, and meaningful assertions in plan approval/tool tests.
Existing RS.1 through RS.6 changes were excluded. No tests were rerun by this
reviewer; root owns the running full gates and terminal checks.

## Final verdict

No remaining blocking correctness finding in the final frozen production diff.
The final synchronization notification fix and both known-override ordering
assertions have been reviewed. This verdict is a source/test review; root owns
the focused and full command results.

## Synchronization findings resolved during review

The first synchronization finding has been fixed with a retained latest task and
an await loop. That prevents a stale request read from proceeding before a newer
pending read and preserves rejection from the latest task.

A subsequent public SDK liveness reproduction used an already resolved startup
plan getter, followed by deferred request read A and clear-triggered read B.
Start a prompt, clear the interactive override, resolve A, and let the await loop
advance to awaiting B. Then commit a known interactive acceptEdits override.
Although the setter clears the latest-task reference and projects the right
tools, the request is already suspended inside `await B` and cannot inspect that
clear until B settled. If B never settled, the known-mode override could not
release the request.

The final `_setPendingPlanToolSync` helper replaces the raw latest-task reference
and aborts the previous private change signal. Waiters race their raw task
against that change signal, then follow the latest reference or return after a
known override clears it. The setter projects the committed mode before notifying
waiters; disposal also notifies. Each wait removes its abort listener in `finally`.
`Promise.race` installs rejection handlers on raw tasks even when a change wins,
so abandoned getter failures are handled while current/latest failures propagate.
The controller is captured and its listener attached synchronously before await,
avoiding a notification registration gap.

The revised provider test checks overrides both before and after following the
newer pending read, proves a provider request occurs while that read is still
unresolved, then proves its late plan result cannot reinstate the implicit tool.

## Resolved during review

- Transcript restoration projected executable tools but rebuilt an unprojected
  prompt. Restoration now calls the common requested-loadout projection; the
  tree test asserts immediate active-tool and prompt agreement.
- Recorded automatic plan tools became explicit when restored through tree
  navigation. Restoration now retains known explicit session intent and filters
  transcript-only plan names. Tests cover automatic removal and explicit retention.
- A hook editing another tool could copy the implicit plan tool into run intent.
  Hook projection now filters inherited implicit plan names; a real continuation
  test proves removal after approval while preserving the hook's other exclusion.
- A superseded request read could outrun a newer pending read, omitting the plan
  tool, or hide its error. The latest-task await loop and adversarial provider/error
  regressions now cover both ordering cases.

## Other reviewed boundaries

The session owns the injected presenter without exposing mode mutation to
extensions. Signal propagation and binding/lifecycle/mode generations prevent
obsolete approvals; the private setter checks cancellation immediately before
commit and the presenter verifies the returned interactive resolution. Gate-less
session approval fails clearly. Registry eligibility remains authoritative for
allowlists, exclusions, and no-tools. Explicit tool intent survives mode exit;
run-scoped hook intent resets after a run. Workflow `nextMode` is additive and the
tool schema remains unchanged. Type and factory exports are available from the
package entry point; its prompt snippet names the active tool. The existing footer
refresh retains its session identity check.

Coverage includes actual next-provider-request tool removal, actual edit gate
behavior, additive evidence capture, file/custom mode sources, tree restoration,
resume, stale dialog/pending setter cases, and interactive footer updates. The
pending synchronization cases now have adversarial provider, latest-error, and
both known-override ordering assertions.
