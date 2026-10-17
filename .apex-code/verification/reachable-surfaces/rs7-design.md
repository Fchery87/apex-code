# RS.7 synthesis and throughput checkpoint

## Grounding

SDK tool selection feeds AgentSession registry eligibility and initial loadout.
The runtime wraps built-ins through ExtensionRunner.createContext, whose UI getters
resolve current bindings. InteractiveMode supplies the actual selector. The session
owns the in-memory permission mode and the next-request loadout refresh. Evidence
is captured by the tool contract and serialized by the existing evidence sink.

## Synthesis

Candidate A requested-tool projection is the base. Candidate B supplies the smaller
existing tool-result footer refresh. Both candidates and the independent judge
agree that registry ceilings stay authoritative, the mode comes from the live gate,
and optional signal plus generation checks prevent stale approvals. The ownership
flag alternative is rejected because reload and refresh can promote automatic
activation to explicit intent. No extra permission setter enters ExtensionContext.
The spec records cancellation, gate-less failure, and restrictive-loadout behavior
before implementation. Run-scoped extension selections retain their lifetime.

## Throughput checkpoint

- Blocking first steps. Latest spec and plan read; source trace and two independent
  designs completed before the source writer starts.
- Independent workstreams. Design and trace agents write separate artifacts. Root
  owns docs and terminal fixture; one implementation owner writes code and tests.
- Shared mutable state. AgentSession owns mode and tool projection. Production
  writes serialize through one owner, while independent review is read-only.
- Smallest safe decomposition. Presenter, mode, request loadout, and UI completion
  form one feature. One owner keeps lifecycle changes coherent. Focused red/green
  loops verify each boundary before full root gates.

## Verification policy

Keep test output and CLI transcripts in this directory. All turn and session tests
use scratch cwd. Root reads the diff and exercises the actual terminal. Commit and
PR steps remain pending because poteto-mode requires the unavailable deslop plugin.

## Implementation corrections

SDK construction and reload cannot await arbitrary startup getters because the
existing public API admits unresolved getters and permits callers to resolve them
after obtaining the session. Startup activation is guarded and detached; actual
provider requests await the live authority. No new initialization API is needed.

The initial legacy-transcript preservation proposal was rejected during review.
New automatic additions also appear in system tool records, so inferring explicit
intent from those records would retain the tool after approval. Tree restoration
preserves known current explicit intent, filters ambiguous transcript-only plan
tool names, and then applies the current mode projection to tools and prompt.
Hook edits similarly avoid promoting inherited automatic additions.

The manual probe legacy provider context did not expose active schemas through
context.tools. Its initial “Active tools: none” text is not evidence of the tool
loadout. Actual session system records prove two plan_present removals after the
two approved choices; the real provider continuation tests supply request proof.
The fixture now uses a plain completion message.
