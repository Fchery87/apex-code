# Plan: Checkpoints on by default (spec 2026-09-01-checkpoints-default-on.md)

**Status:** In progress -- opened 2026-09-01

Task numbers are identifiers, not a sequence. A task is **done** only when its
check has actually run and passed.

| Task | State | Commit SHA |
| --- | --- | --- |
| CP.1 -- Default flip in `session-checkpoints.ts` + the two pinned tests flipped (unit + SDK wiring) + explicit-disabled pin | **done** -- verified by `test/checkpoints/session-checkpoints.test.ts` + `session-wiring.test.ts` | -- (this commit) |
| CP.2 -- Settings schema comment + engine comment describe default-on and the opt-out | **done** -- comment blocks updated; accessor tests unchanged and green | -- (this commit) |
| CP.3 -- Gates (tsgo, biome, targeted vitest, full `npm test`), commit, CI, land | **in progress** -- tsgo clean, biome clean, check:docs passed, full `npm test` exit 0 (3,178/58 across 377 files); commit + CI pending | -- |

## Decisions taken during execution

- **The default lives at the engine, not the accessor**: `getCheckpointSettings()`
  keeps returning `undefined` for an absent key (checkpoint-settings tests must
  pass unchanged), and `createSessionCheckpoints` interprets absent as
  `enabled !== false`. One place owns the policy; the SDK/CLI wiring stays a
  pure passthrough.
- **First-run interactive notice deferred**: the TUI hint system exists, but a
  checkpoints hint wants restore-UX guidance alongside it; recorded as a
  non-goal in the spec rather than shipping a half-message.

## Verification

Test-first: the two "absent means nothing" pins are rewritten to default-on
pins and must fail before the one-line flip. At closure: `npx tsgo --noEmit`,
`biome check`, `npm run check:docs`, and the full `npm test` (both workspaces)
as the final gate; three-OS CI before landing.
