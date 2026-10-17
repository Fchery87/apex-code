# RS.8 / RS.9 synthesis and throughput checkpoint

## Choice

Use candidate A. Independent judge scored A 29/30 and B 24/30.
The pull panel caches validated branch snapshots by live session, session ID,
and leaf ID. Each frame checks actual tool selection. No new session or storage
observer APIs, timer, model context, or task storage are introduced. Candidate B
adds project-shadowed settings feedback and lifecycle test coverage.

SDK and low-level construction currently compute different initial defaults.
One internal helper owns the names; SDK captures its original configured defaults,
and low-level construction retains its current activation behavior. Saved settings
seed from that construction provenance rather than current CLI or hook tools.

The latest spec records the Alt+J default, whole-run completion timing, next-frame
SDK updates, bounded text, and future-session settings behavior before implementation.

## Throughput checkpoint

- Blocking first steps. Latest spec/plan, branch/widget/lifecycle trace, two designs,
  and independent judge finished before source writing.
- Independent workstreams. Design and trace artifacts are separate. Root owns
  spec, plan, user docs, terminal driving, benchmarks and final gates.
- Shared mutable state. One implementation owner writes component, integration,
  renderer, settings and tests. Independent review is read-only against the saved
  RS.8 starting snapshot.
- Smallest safe decomposition. One owner keeps panel/lifecycle/tool settings
  coherent. Verify RS.8 focused red/green loops before implementing RS.9.

## Verification contract

Scratch cwd for every session/turn/state test. Component/mode tests cover branch,
compaction, resume, replacement, hook loadouts, completion/retry settlement,
extension widget coexistence, safe bounded rows, keys, command routing, persistence,
tool-cell errors and disclosure. Settings row tests preserve exact construction
defaults and custom arrays, show project overrides, affect new sessions only,
and retain restrictive CLI behavior.

Root drives the actual source terminal and runs full npm test/check once after
the final slice is frozen. Performance compares source-identical trunk baseline
with head back to back on an idle host, plus mounted production dock/panel runs.
The existing transcript-only benchmark cannot measure panel overhead.

## Skill limitations

Configured external skill models, control-cli, and deslop are unavailable.
Supported inherited models perform the mandated design, implementation and
review roles. Root exercises the actual terminal directly. Commits and PR opening
remain pending because the pre-commit deslop requirement cannot be met.
