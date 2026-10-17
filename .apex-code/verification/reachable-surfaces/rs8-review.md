# RS.8 / RS.9 frozen correctness review

No blocking correctness findings were found in the reviewed snapshot.

This is an independent read-only review of the 17 incremental TypeScript source
and test files against `/tmp/apex-rs8-baseline/packages/coding-agent`. Earlier
RS.1 through RS.7 changes are excluded. The review read the current reachable
surfaces spec, plan, synthesis, owner command record, tests, relevant existing
session/settings/rendering boundaries, and decision trail. It used the available
inherited model and does not claim model diversity. No source, test, or tracked
document was changed by this reviewer.

## Correctness assessment

- `task-panel.ts:48` caches owned normalized snapshots by session object, session
  ID, and leaf ID. It reads the unabridged current branch, so other branches and
  compacted model context cannot substitute for persisted task state. Existing
  entries are append-only; in-place mutation is explicitly outside the update
  contract. Repeated unchanged renders avoid `getBranch()`.
- `task-panel.ts:81` checks actual tool selection each frame, independently of
  cached task data. Inactive and empty lists hide immediately on that frame.
  Completed lists are retained only when a new snapshot arrives during the run;
  `agent_settled` clears retention, while intermediate `agent_end` preserves it.
  Starting another run cannot revive the previous complete snapshot. Same-session
  rebind uses the existing whole-run `isStreaming` authority to clear retention
  after a missed settlement.
- `interactive-mode.ts:742` composes a core panel with a separate extension
  widget container. Extension map replacement and clearing affect the nested
  extension container, preserving core chrome. Both renderer layouts consume the
  same above-composer container. Settlement forwards to the panel and requests a
  frame.
- `todo-write.ts:6` validates imported rows, takes owned copies, removes terminal
  controls, flattens whitespace, and truncates by terminal columns. The pinned
  panel caps expansion at five task rows plus one overflow row. Width zero and
  one are covered. The renderer-only registry imports executable tool types with
  `import type`; it does not load task execution schemas to display them.
- `todo-write.ts:38` hides the pending call label after results, displays one
  compact success count, preserves actual error text, and supplies full task
  disclosure through the existing tool-cell expansion machinery. Mounted tests
  cover mouse disclosure and the actual Ctrl+O action. Existing custom renderer
  precedence remains intact.
- `/tasks` is registered and dispatched; `app.tasks.toggle` has Alt+J and is
  reserved through the effective extension shortcut configuration. Tests cover
  the Meta input sequence, collisions with app defaults, rebinding reservation,
  and routing both command and action to the same toggle.
- `sdk.ts:446` captures construction defaults before saved settings, explicit
  selections, exclusions, or no-tools restrictions apply. The helper preserves
  existing SDK core-plus-configured-LSP/search/MCP defaults, while
  `agent-session.ts:1946` preserves low-level base overrides or core-plus-LSP
  policy. Copies prevent callers from mutating captured provenance.
- `interactive-mode.ts:5292` updates user defaults only, preserving unrelated
  names and order and removing every task-tool occurrence on disable. It neither
  activates tools nor reloads the current session. Both row configuration and
  callback guard project-controlled defaults. Mounted settings tests prove new
  sessions change while current sessions and reload retain selection; explicit
  tools, exclusions, and both no-tools modes remain authoritative.

## Test and evidence assessment

The four new feature files exercise public components, mounted InteractiveMode
handlers, actual SDK session/tool execution, persistence, and fresh construction.
Session/turn/state tests change into scratch directories before state writes.
The component tests use a narrow session port rather than pretending to construct
a complete AgentSession. Some mounted mode tests intentionally construct only
the host properties needed to drive the real handler; actual terminal verification
remains a separate gate.

I inspected saved output rather than rerunning tests. The final four-feature-file
log reports `Test Files 4 passed (4)` and `Tests 25 passed (25)`. The earlier related
log reports six files and 133 tests passed. The owner records the broader eight
file run, subsequent additional mounted-settlement case, final TypeScript, and
whitespace checks separately, without presenting the earlier count as final.

The decision trail matches observed evidence. Its current-branch grounding points
to `session-manager.ts:421`, where `getLatestTodos` is defined. The chosen cache,
default provenance, and project lock match the design and code. The corrected
behavioral RED log contains five assertion failures; the initial missing-module
failure is explicitly identified as insufficient. The 133-test milestone matches
the saved related output and retains terminal/benchmark/full gates as pending.

The final comment verdict was independently rechecked against the same baseline:
17 changed TypeScript files, zero added comment or suppression candidates. This
agrees with `rs8-comment-review.md`; there is no new suppression to approve.

## Material limits

This review did not execute tests, the CLI, full validation gates, or benchmarks.
Those remain root-owned. Whole-run retry retention is directly tested through
the component event boundary; the new SDK task tests prove real tool execution
and settlement, but do not themselves trigger a real automatic retry backoff.
Frame and latency claims require the mounted performance probe, since the
existing transcript-only benchmark cannot establish panel overhead. No three-OS
CI or completion commit SHA is supplied by this review.

## Final evidence audit (2026-10-04)

The final verification artifact, appended decision-trail rows, performance record,
live plan and roadmap agree with the saved outputs. Full-test summaries show
216 root-script passes with four skips and zero failures; 21 scrubber passes;
975 agent-core passes with one skip; and 455 passed coding-agent files, six
skipped files, 4192 passed tests and 51 skips, taking 1589.38 seconds. The check
log reports `Checked 1195 files in 96s. No fixes applied.` Its subsequent gates
complete, including documentation validation. Exit-zero outcomes and the final
post-document-update checks are recorded in the root command trail; this audit
did not rerun them.

The performance means, p95 range, 24 cases, scan counts and row bounds match the
raw paired and mounted logs. Structural assertions are distinguished from timing
results. Unrelated host activity and the post-suite 67%/62% idle observations
are recorded as limitations, with no no-regression claim or idle-host pass.

No fabricated pass, count/date mismatch, or accidental phase closure was found.
RS.8 and RS.9 remain `Done, unverified` with missing completion SHAs; RS.8 also
retains its idle-host timing requirement. RS.10 and the roadmap remain in progress,
the spec remains Draft, and the plan is retained. Completion commits and three-OS
CI are explicitly pending. Only this review artifact was changed by the audit.
