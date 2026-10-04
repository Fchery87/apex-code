# RS.7 implementation choices

AgentSession owns explicit requested tool names and a separate optional run-scoped hook selection. The effective set adds plan_present only while the same wrapped live permission getter used by authorization reports plan. Registry allowlists and exclusions remain the ceiling. An explicit API selection or configured default/CLI selection remains after approval.

SDK construction remains nonblocking for asynchronous custom mode getters. This preserves the existing RS.5 deferred-startup and failed-startup public behavior. Synchronous getter results project immediately. The captured startup promise reconciles tools when settled with handled rejection and a generation guard. First prompt and every next-response preparation await a fresh actual getter; that is the executable request guarantee. Reload/clear schedules handled reconciliation rather than blocking on an arbitrary unresolved custom getter. No SDK API or persistence schema was added.

Historical tool declarations do not establish explicit intent. Tree restoration preserves known current explicit plan_present intent, ignores a transcript-only occurrence, and reapplies current mode projection. This deliberately corrects the original candidate-A suggestion to guess that every historical occurrence was explicit. It prevents turns recorded in plan mode from pinning an automatic addition after approval or resume.

Hook-edited names inherited from an automatically projected plan_present do not pin it within the run. Other hook edits retain their run scope. An explicit public tool setter remains the way to pin a tool already projected automatically.

The presenter uses the existing three-choice UI and visible notify surface, forwards the tool signal, and checks lifecycle/binding and mode generations. Its private guarded mode setter checks lifecycle invalidation immediately before committing after the startup await. Session-owned approval without a permission gate fails clearly.

Successful plan_present tool-result events refresh the existing footer, which already guards session identity across the await. No new public event was added.

The historical prompt regression had two separate causes. Restoration previously rebuilt prompt options from unprojected historical names, now fixed by the shared projection owner. Independently, plan_present lacked a promptSnippet, so even a correctly selected approval tool had no text in the normal system prompt. A snippet reuses its existing description; it does not change the contract.

No pi-ai/pi-tui source was modified. No c-code source was accessed. No commits were created. Full suite and npm run check are root-owned final verification.

A final independent review found a request-barrier race: discarding an obsolete read prevented stale mutation but did not prove the newest read had settled. Requests now follow the last raw synchronization task, including a newer rejected task already handled by the detached caller. The settled reference stays until another read or a committed known override replaces it. Clear/reload remain nonblocking, and a known override clears the pending authority after projecting its mode. Red tests prove a premature actual provider request and an ignored latest error; a positive test proves a newer known override wins without waiting for the old background getter.

The final liveness proof covers both orders for a known override. Once a waiter already followed unresolved latest read B, clearing its reference alone cannot wake that waiter. One session-owned AbortController now signals authority replacement. Task installation, committed known override, and disposal replace and abort the previous controller. Waiters race the retained raw task against that notification and remove their listener in finally. This introduces no timers or polling in production and preserves propagation of the latest raw getter error. The new after-following case failed before the fix and passed afterward.

The root full suite exposed a pre-existing low-level idle assumption in regression #5943: agent.waitForIdle could return before newly asynchronous session preflight entered the agent. The test now waits for the public agent_settled event from its already-installed subscriber. It retains all ordering and message assertions and adds file-scoped scratch cwd hooks. Session.waitForIdle was inspected but is not used because its current idle predicate also excludes preflight. This correction changes only the existing test fixture; it introduces no production lifecycle change.
