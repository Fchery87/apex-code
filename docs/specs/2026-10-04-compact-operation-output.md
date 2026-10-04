# Spec: Compact operation output

**Status:** Active

## Outcome

Overview displays one physical row per tool or user shell operation. The row names
the action, target, lifecycle, and a factual result summary. Assistant answers remain
readable Markdown. Details retains previews, thinking, and edit diffs. All retains
full available output. The existing saved detail preference continues to apply.

## Design

Operation components own compact presentation. A shared row renderer uses existing
theme roles, ANSI-aware clipping, and the configured Unicode or ASCII symbols.
Overview has no panel background, spine, border, or per-operation blank row.
Labels remain readable, metadata is muted, and errors retain a short diagnostic.
Running operations update in place. Counts describe available output, never claim
test success or complete search results without supporting metadata.

The existing call renderer supplies extension labels. Unknown tools receive a
bounded name and output summary rather than serialized arguments. Explicitly hidden
extension output stays hidden. Full rendering and stored session data stay intact.
Images appear on expansion. Long commands, Unicode paths, and multiline inputs
cannot make a compact row wrap.

Clicking a compact row expands that operation, including its edit diff. A new
configurable Alt+O action toggles the latest operation without expanding the rest
of the conversation. Ctrl+O still cycles overview, details, and all, and resets
individual overrides. A single muted mode indicator describes that cycle.
Live, resumed, and pending shell operations receive the same presentation state.

## Alternatives and synthesis

Two independent design reviews compared renderer-owned summaries with central
component composition. Renderer-owned summaries require changes across every tool
and a new public rendering option, while still needing a generic fallback.
Component composition guarantees one row for existing tools and extensions and
reuses lifecycle ownership. Choose component composition and a shared row renderer.
Retain existing extension call labels and factual result counts. Do not add a public
summary API in this slice.

## Verification

Write and run failing public component-rendering tests before implementation.
Cover built-in and unknown tools, self-rendering extensions, errors, images,
streaming, narrow widths, click expansion, edit diffs, user shell operations,
detail propagation, and the latest-operation shortcut. Use scratch directories
for session-writing tests. Run focused tests, `npx tsgo --noEmit`, `npm run check`,
and one final `npm test`. Exercise the resulting components in an actual terminal
with deterministic fixtures and capture the results under `.apex-code/`.

### Local verification, October 4, 2026

The implementation is verified locally and awaits integration. Public rendering
tests failed before the corresponding fixes and now pass, including error selection,
long-label diagnostics, queued clicks, individual collapse, and blank output lines.

- Focused nine-file run: 178 tests passed. The final compact component run passed
  all 21 tests after the output-line counting correction.
- Release review identified shell output-selection and expanded queued-argument
  click issues. Both new tests failed before fixes, then the compact suite passed
  all 23 tests. An independent reviewer confirmed the mouse targets against the
  real expanded layout and reran the 23 passing tests.
- `npx tsgo --noEmit`: exit 0, no diagnostics.
- `npm run check`: exit 0; `Checked 1196 files in 15s. No fixes applied.`
- `npm test`: exit 0. Script tests passed with no failures; scrubber tests passed
  21 tests, agent-core passed 975 with 1 skipped, and coding-agent passed 4216 with
  51 skipped across 456 passing and 6 skipped files.

The initial sandboxed full run could not create a tsx IPC socket (`listen EPERM`).
The same script boundary passed outside that restriction, followed by the complete
passing run. Logs are in `.apex-code/prototypes/compact-output-review/`, including
`npm-check-final.txt`, `npm-test-unrestricted.txt`, and `blank-lines-green.txt`.

A deterministic fixture exercised the real terminal renderer at 100 and 50 columns.
Overview displayed six operations in six rows. Global detail cycling, latest-row
expansion, and individual collapse within all restored or hid output as expected.
Captures are `overview-100.txt`, `overview-50.txt`, `latest-100.txt`, `all-100.txt`,
and `collapsed-item-in-all-100.txt` in the same artifact directory. The fixture did
not execute commands or model calls.

## Deletion inventory

In overview, remove output previews, panel decoration, per-operation blank rows,
unbounded unknown-tool arguments, and repeated overview expansion hints.
Keep details and all rendering, session records, and upstream dependencies.
