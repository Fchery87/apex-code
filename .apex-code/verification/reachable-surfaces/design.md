# Tree checkpoint preview design

The public result is the spec's `TreeWorkspacePreview` union. Its states are
`no-checkpoint`, `unavailable`, `matches`, and `differs`.

Two read-only design candidates compared the internal shape before implementation.

| Criterion | Candidate A, inspection union | Candidate B, typed operational errors |
| --- | --- | --- |
| Exact public preview shape | Direct projection | Projection through catches |
| Existing navigation outcomes | Explicit outcome metadata | Error classification in catches |
| One comparison per inspection | Yes | Yes |
| Internal boundary | One result union | Result shape and error class |
| Expected unavailable states | Data | Exceptions |

Candidate A is the base. The cross-judge agreed. No graft was needed.
It keeps expected failure states in the result and preserves the old distinction
between missing checkpoints and failed comparisons.

`_inspectTreeWorkspace()` owns engine lookup, checkpoint lookup, and comparison.
Matching and differing results retain the engine and checkpoint for navigation.
`previewTreeWorkspace()` removes those internal fields.
`_resolveTreeWorkspaceStep()` keeps its immediate return for `keep` and catches
restore failures separately.

The interactive handler owns both questions. It asks about summarization first,
then previews settled files after aborting any active response. It checks
compaction after preview and after the restore dialog. It passes the selected
policy to the existing navigation contract and reports the workspace outcome.

One implementation owner changed the session, extension declarations, handler,
and their tests. The coordinator owned documentation and terminal verification.
This kept shared source edits with one writer.

## Turn duration

Two independent designs compared a timestamp on `InteractiveMode` against a separate
event-driven tracker. The timestamp is the base. The tracker adds another interpreter
of the same lifecycle without reducing its state. A stateless component owns duration
formatting. The handler preserves the timestamp across tool steps and retry attempts.
An explicit optional abort field on `auto_retry_end` covers cancellation during
backoff, which has no final `agent_end`. Settlement clears any remaining timestamp.

## Interactive permission mode

The read-only trace found three enforcement consumers of the configured gate getter.
Tools, configured commands, and delegated children must all observe the override.
A display-only change to `getPermissionMode()` would leave enforcement unchanged.

| Design | Benefit | Cost |
| --- | --- | --- |
| Copy and wrap each session's gate | Existing tool and command consumers share the override | One live forwarding change for delegation |
| Inject a separate mode authority throughout setup and services | Explicit authority object | More signatures and replacement plumbing |

The copied gate is the base. It uses the optional session value when present and the
original configured getter otherwise. The original object is never mutated. The
session exposes a synchronous override reader, an asynchronous setter that checks
the immutable startup bypass ceiling, and a clear operation. Delegated children read
the parent's override at each decision and fall back to the original getter. Rule
resolution remains unchanged, including existing bypass semantics.

RS.6 serializes repeated key presses so asynchronous mode reads cannot merge two
cycles. Existing first-use-hint storage remembers the binding migration notice.
The footer receives resolution origin and uses live keybinding display text.

The blocking steps are grounding, design synthesis, and failing boundary tests.
Read-only investigations and coordinator documentation are independent. Source
changes to the session and interactive handler have one owner. The smallest verified
sequence is RS.4, then RS.5, then dependent RS.6. Fresh implementation owners are
preferred; the tool's agent thread limit required reuse of a completed design agent
with the full implementation scope supplied again.

The cycle queue belongs to the current TUI session binding. Both rebind and reload
invalidate its generation and clear the queue before awaiting work. This drops old
requests and lets a replacement session cycle without waiting for an old mode read.
The failed-reload path refreshes the footer because the core clears the override
before loading resources; a resource failure must not leave the old mode displayed.
The regression observed `default` with interactive origin in the stale footer while
the authoritative resolution was startup `bypassPermissions` with flag origin.
