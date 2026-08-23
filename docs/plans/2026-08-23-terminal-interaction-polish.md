# Plan: Terminal interaction polish

**Status:** Active — implementation in progress

**Spec:** [docs/specs/2026-08-23-terminal-interaction-polish.md](../specs/2026-08-23-terminal-interaction-polish.md)

This plan tracks a product-surface follow-up after the numbered roadmap phases. Task IDs are stable references, not sequence numbers. Finished tasks receive their verified commit SHA in the same commit; this plan is deleted when all tasks are complete.

## Task table

| Task | Work | State | Commit |
| --- | --- | --- | --- |
| TUI.1 | Pin tool status-card and responsive-tray behavior with failing public-boundary tests | done | ec752d593 |
| TUI.2 | Implement the Apex-owned tool status shell, compact summaries, single disclosure hint, elapsed state, and bounded collapsed errors | done | ed465e209 |
| TUI.3 | Implement the one-row responsive status tray with semantic drop priorities and full/off compatibility | done | ec752d593 |
| TUI.4 | Add compact delegation summaries at the existing delegate tool boundary | done | ed465e209 |
| TUI.5 | Add event-driven first-use hints with bounded persistence and safety-state priority | done | 74b3ccd68 |
| TUI.6 | Refine the Apex-owned composer within public `pi-tui` limits and pin width/cursor behavior | done | 74b3ccd68 |
| TUI.7 | Add a common searchable configuration entry point that routes to existing settings/provider/model/MCP handlers | done | 74b3ccd68 |
| TUI.8 | Update user-facing docs and the durable spec with actual behavior and any evidence-driven deviations | done | 74b3ccd68 |
| TUI.9 | Run UI detector, `npm run check`, narrow suites, coding-agent suite, root `npm test`, and confirm frozen `packages/tui` is unchanged | in progress — narrow suites, detector, and check passed; coding-agent suite was non-conclusive | — |
| TUI.10 | Record verified SHAs in the roadmap/spec and delete this completed plan | not started | — |

## Working rules

- Write and run the failing test before each implementation slice.
- Keep tool contracts and execution semantics unchanged.
- Do not modify `packages/tui`.
- Preserve extension renderer compatibility and all safety-critical text.
- Use complete semantic segments under width pressure; do not truncate through warning labels.
- Run the narrowest test file first, then broaden.

## Order changes

None.
