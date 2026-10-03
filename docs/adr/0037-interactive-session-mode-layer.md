# ADR 0037 — A permission mode chosen inside a running interactive session governs that session and is never persisted

**Status:** Accepted · **Date:** 2026-10-03

A running interactive session may hold one extra mode value, set only by the person at
the terminal: the mode-cycle key, or approving a plan. While set, it is the session's
effective permission mode, above every configured source including `flag`. It changes
the mode only, never rule resolution. It is held in memory and is never written to any
file. It can select `bypassPermissions` only if `bypassPermissions` was already allowed
when the session started.

## Context

ADR 0004 orders permission sources `policy > flag > local > project > user > cliArg >
command > session`, and `MODE_SOURCE_ORDER` in `permissions/startup.ts` applies the same
order to modes. Interactive mode can change the mode only through `/settings`, which
writes `destination: "user"` and so changes the default for every future session.

`docs/specs/2026-10-03-reachable-harness-surfaces.md` needs a per-session mode for two
goals: a key that cycles modes for this session (G2), and plan approval that leaves plan
mode (G3). `docs/research/2026-10-03-harness-display-survey.md` records that Codex CLI
and Claude Code both switch modes per session and both switch mode when a plan is
approved.

The existing `session` source cannot carry this. It ranks lowest, so any mode saved in
`user`, `project`, or `local`, or passed with `--permission-mode`, silently wins over it.
The cycle key would appear to do nothing in exactly the sessions where someone has set
a default.

## Decision

1. **A separate mode-only layer.** `interactiveMode?: PermissionMode` lives on the
   running session's permission state. When present it is the effective mode. When
   absent, resolution is unchanged from ADR 0004.
2. **Above `flag`.** ADR 0004 ranks `flag` above config because "an operator who types
   one has made a decision that project config should not silently reverse." This layer
   is not config and is not silent. It is the same operator, choosing again, in the
   session, with the footer showing the result. Ranking it below `flag` would make the
   cycle key inert in every session started with `--permission-mode`, including the
   common `--permission-mode plan`.
3. **Mode only.** Rules keep ADR 0004's order. A `deny` rule still denies in every mode,
   and the deny rule written by "Reject always" keeps its meaning.
4. **Never persisted.** The value is not written to `permissions.json`, the session
   file, or settings. Resume, reload, and a new session start without it. `/settings`
   remains the way to change the saved default.
5. **No escalation past startup.** `bypassPermissions` is selectable only when the
   effective mode at startup was `bypassPermissions`. Otherwise the cycle is
   `default → acceptEdits → plan`, and plan approval offers only `acceptEdits` or
   `default`.
6. **Interactive only.** Only the interactive TUI sets it. Print, JSON, and RPC modes
   have no way to set it. ACP's `setMode` keeps calling `setPermissionMode()`, which
   writes user scope; whether ACP should adopt this layer is left to a later decision.
7. **Visible origin.** Mode resolution reports origin `"interactive"` when the layer
   applies, so the footer and `/settings` can say the saved default is shadowed for this
   session.

## Alternatives considered

- **Raise `session` in ADR 0004's order.** Rejected: `session` also ranks rules, so this
  would change what session deny rules override, including "Reject always".
- **Write the `session` source and leave it lowest.** Rejected: the key would be ignored
  whenever any file or flag sets a mode, which is a control that silently does nothing.
- **Keep writing `user` scope, as `/settings` does.** Rejected: switching to plan mode for
  one task would change every future session's default.
- **Rank the layer below `flag`.** Rejected for the reason in Decision 2.
- **Let the layer reach `bypassPermissions` freely.** Rejected: a single key press would
  turn off every prompt in a session that started with prompts on.

## Consequences

- Easier: plan approval and the cycle key work the same way whatever the user has
  configured, and nothing leaks into later sessions.
- Easier: rule semantics and every existing precedence test stay valid.
- Harder: a session's effective mode can now differ from both its config and its flag.
  Anyone reading a session's behavior has to check the footer or the resolution origin,
  not just the files. A test must assert the origin is reported.
- Harder: `--permission-mode` no longer pins an interactive session's mode for its whole
  life. An operator who needs a locked mode should run non-interactively, where the
  layer cannot be set. This is a narrowing of what the flag guarantees in interactive
  sessions, and it is the main cost of this decision.
- Unchanged: non-interactive behavior, the headless startup requirement, and ADR 0004's
  rule model.
