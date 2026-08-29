# Spec: Terminal interaction polish

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | `Apex Code` |
| Created | `2026-08-23` |
| Last updated | `2026-08-23` |
| Roadmap phase | `none — product-surface follow-up after Phase 12` |
| Tracking issue/PR | `none` |
| Compatibility posture | Preserves compatibility. Session files, settings keys, tool contracts, extension renderers, and keybindings remain valid. The default compact presentation changes, while `tokenUsageDisplay: "full"` and global tool expansion preserve detailed views. |

## Executive summary

Apex Code will make tool work and operating state easier to scan in the terminal. Tool executions gain explicit text lifecycle states, compact summaries, one consistent disclosure hint, and quiet completed styling. The lower dock becomes a responsive status tray that keeps permission and context warnings visible before lower-priority usage metadata. Follow-up slices add bounded error disclosure, elapsed activity, delegation summaries, contextual hints, composer polish through Apex-owned code, and a clearer configuration entry point.

## Context and motivation

- `docs/adr/0019-welcome-screen-brand-mark.md` settled the Apex mark, palette, prompt marker, placeholder, command tint, and the rule that input chrome stays in `CustomEditor` rather than modifying frozen `pi-tui`.
- `docs/adr/0001-fork-boundary.md` keeps `pi-tui` a consumed dependency. This change must use Apex-owned components and public APIs.
- `docs/architecture/contracts.md` and ADR 0010 make tool contracts the only source of capability and permission classification. Presentation must not reclassify tools.
- The design review for this work compared the current Apex TUI with Prime-Agent's interaction patterns. Prime is used as behavioral reference only. Apex keeps its own colors, symbols, safety state, commands, and product features.

No roadmap phase owns this refinement. All numbered phases are landed, so this is recorded as a product-surface follow-up rather than reopening a completed phase.

## Prior state

`ToolExecutionComponent` composes extension or built-in call/result renderers inside a background box. It tracks partial arguments, execution start, partial results, final results, errors, image rendering, and global expansion. The lifecycle is mostly implicit in background color. Several built-in renderers add their own expansion hint, so disclosure copy varies and can repeat.

`FooterComponent` emits two default rows before extension statuses. The first carries CWD, branch, and session name. The second combines token counts, cache data, cost, context, experimental state, permission mode, provider, model, and thinking level. Under width pressure it truncates strings rather than removing semantic groups by priority. A dangerous permission mode or pressured context can therefore compete with routine metadata.

`CustomEditor` already owns Apex's `> ` marker, placeholder, and slash-command tint. Its base editor API does not expose a background hook. Settings, providers, models, and MCP-related controls are reached through separate commands and selectors.

## The problem

A user must infer whether a tool is waiting, running, complete, or failed from color and changing content. That fails in low-color terminals and makes a long turn slow to scan. Routine completed tools consume the same visual weight as active or failed work. Multiple renderers own their own disclosure copy.

The footer shows useful facts but treats them as peers. Narrow terminals clip by character count rather than by meaning. Permission posture and context pressure must survive before cache rates, cost, provider, CWD, and session labels.

The remaining interaction details are fragmented. Long errors can take over the transcript. A running operation does not always give a compact elapsed label. Delegation output lacks a stable parent-level summary. Hints are concentrated at startup rather than shown when a feature first becomes relevant. Configuration is spread across commands with no common index.

## Implemented behavior

Implementation commits: `ec752d593`, `ed465e209`, `74b3ccd68`, and `697746b94`.

- Tool execution cards now retain their explicit lifecycle state while collapsed errors
  show at most three visual lines; expansion remains the route to complete output.
- Running cards refresh a stable elapsed label, and delegate results use a compact
  parent-level summary until expanded.
- First-use hints are emitted only from live tool, queue, thinking, and bash interactions.
  The compact `firstUseHints` settings ledger prevents repeat hints across sessions.
- `CustomEditor` supplies text-only `bash` and `busy` labels. The formerly omitted filled
  editor surface is complete and verified by the
  [`composer dock surface` spec](2026-08-23-composer-dock-surface.md).
- `/config` opens a searchable index for existing settings, model, provider, and trust
  handlers. Resources, extensions, and MCP adapters deliberately hand off to the exact
  `apex-code config` command, which already owns scope and project-trust handling.

## Goals

- [x] Every ordinary tool row names one lifecycle state in text: `queued`, `running`, `done`, or `error`; symbols and color are secondary channels.
- [x] Completed tool rows are visually quiet. Running, warning, error, and permission states retain emphasis.
- [x] Collapsed results expose a compact summary and at most one expansion hint per tool component.
- [x] Tool rows stay within width at narrow and wide terminal sizes and retain extension renderer compatibility, images, and self-rendered shells.
- [x] Default compact footer output is one responsive tray row. Permission mode and context pressure survive before model, thinking, tokens, cache, cost, provider, CWD, branch, and session details.
- [x] `tokenUsageDisplay: "full"` remains an explicit detailed usage view, and `off` still hides token and cost data without hiding model/context safety state.
- [x] Long tool errors are bounded while collapsed and fully visible after expansion.
- [x] Running work exposes a stable elapsed label without decorative animation.
- [x] Delegated work has a compact parent-level summary that does not duplicate child transcripts.
- [x] Contextual hints appear only on relevant first-use events and never replace safety state.
- [x] Composer polish remains Apex-owned and works through the public `pi-tui` API. Unsupported filled-background behavior is not simulated unsafely.
- [x] A common configuration entry point makes existing provider, model, MCP, and settings controls findable without replacing their established commands.
- [x] ASCII symbols, color-blind mode, authentication/model errors, sandbox state, and extension statuses remain compatible and visible.

## Non-goals

- Modifying or vendoring `packages/tui`. ADR 0001 and the frozen-package gate prohibit it.
- Copying Prime-Agent's palette, logo, source text, or product-only features. The interaction principles are reimplemented in Apex terms.
- Changing tool permission, capability, evidence, or execution semantics. This is presentation and navigation work.
- Adding ornamental shimmer or permanent random tips. Motion is limited to meaningful existing activity signals.
- Replacing existing detailed commands or extension renderers. The new shells compose around public renderers and the configuration index routes to existing controls.
- Hiding bypass mode, plan mode, context pressure, sandbox violations, or authentication/model failures for visual calm.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Tool status shell | Add an Apex-owned shell that derives presentation state from `ToolExecutionComponent`'s existing lifecycle, renders an explicit status marker/label, and applies state emphasis without touching tool contracts | `components/tool-panel.ts`, `components/tool-execution.ts` |
| Tool summaries | Derive bounded summaries from safe presentation data such as tool label, path/command, output line count, result details, and elapsed time. Fall back to the tool name plus lifecycle without guessing capability | `components/tool-panel.ts`, `components/tool-execution.ts` |
| Disclosure | Move the ordinary collapsed hint to the shell and remove duplicate built-in hints. Expansion remains the existing global `app.tools.expand` action | tool renderers under `src/core/tools/`, tool component |
| Error disclosure | Bound collapsed error text by visual lines and expose the full text under existing expansion | tool component and/or a small Apex-owned collapsible error component |
| Status tray | Build semantic segments with explicit priorities, then fit complete segments into one row. Permission and context are mandatory; routine metadata drops before either | `components/footer.ts` |
| Detailed usage | Keep exact token counts, cache rate, cost, provider, CWD, branch, and session information when `tokenUsageDisplay` is `full`; preserve extension status rows | `components/footer.ts`, existing `/usage` behavior if present |
| Delegation summary | Render aggregate delegated task state at the parent tool boundary using existing delegate result details, with full child detail behind expansion | delegate renderer / interactive components |
| Context hints | Add a small first-use hint controller keyed by meaningful events and persisted through existing settings/state facilities where suitable | interactive components and settings manager |
| Composer | Refine spacing, state labels, and mode feedback in `CustomEditor` only where the inherited public API supports correct width/cursor behavior | `components/custom-editor.ts`, interactive wiring |
| Configuration index | Add a searchable selector or command that routes to current settings, provider login/config, model, and MCP controls. Existing commands stay canonical | interactive mode, selector components, slash commands |

Tool lifecycle is a presentation-only discriminated union. `ToolExecutionComponent` remains the source of truth because it receives the actual loop events. The shell never derives capability or risk from a tool name.

The tray uses whole semantic segments rather than substring truncation. At minimum, a non-default permission mode and context pressure render in full when width permits. At extremely small widths each has a documented compact label, and permission wins ties when both cannot fit.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| Per-renderer ordinary `app.tools.expand` hints | behavior/code | superseded by one shell-owned disclosure hint |
| Default two-row footer composition | behavior/code | superseded by the responsive compact tray; detailed `full` mode retains the complete information |
| Color-only implicit tool lifecycle | behavior | superseded by explicit lifecycle text plus symbols/color |
| Unbounded collapsed tool errors | behavior | superseded by bounded collapsed error disclosure |
| Separate, hard-to-discover configuration entry points as the only navigation | behavior | retained as canonical destinations but supplemented by one common index |

## Risks

- A shell can duplicate renderer headers or hide custom output. Public-boundary tests cover built-in, overridden, fallback, image, empty self-rendered, and self-framed tools.
- Tool summary heuristics can misstate work. Summaries use only observed fields and fall back rather than infer.
- A one-row tray can hide data users rely on. `full` remains available, extension statuses remain separate, and width tests pin the drop order.
- Timer-driven elapsed labels can leak intervals. Lifecycle tests use fake timers and assert cleanup after success, error, and abort.
- First-use hints can become noise. Each hint is event-driven, dismissible by occurrence, and lower priority than warnings.
- A common configuration selector can drift from the commands it wraps. It routes to existing handlers instead of reimplementing settings logic.
- Composer styling can break cursor math. Any change is covered at 1-column boundary steps and abandoned if the public API cannot support it correctly.

## Verification

1. Add failing tests to `test/tool-execution-component.test.ts` for all four lifecycle labels, one disclosure hint, error bounding, width safety, custom renderers, and self-rendered shells.
2. Add failing tests to `test/footer-width.test.ts` and `test/footer-accessibility.test.ts` for one-row compact output, semantic drop priority, permission/context survival, ASCII output, color-independent pressure text, and full/off compatibility.
3. Add narrow tests for delegation summaries, contextual hint persistence, composer cursor/width safety, and configuration routing before each slice.
4. Run the narrowest affected Vitest files after each change.
5. Run `npm run check` regularly. This repo's root `check` includes TypeScript; there is no separate `typecheck` script.
6. Run the coding-agent workspace suite, then root `npm test` once after the complete implementation.
7. Run the Impeccable detector once over changed UI files. It targets web patterns, so findings that do not apply to a terminal UI are recorded but not forced into the code.
8. Confirm `git diff -- packages/tui` is empty and run the frozen-package check through `npm run check`.

## Rollout

This needs `docs/plans/2026-08-23-terminal-interaction-polish.md`. The work spans several components and should land in independently verified slices. No new ADR is needed: ADR 0001 already settles the ownership boundary, ADR 0019 settles Apex's visual identity and composer approach, and this spec does not change persisted formats or security policy.
