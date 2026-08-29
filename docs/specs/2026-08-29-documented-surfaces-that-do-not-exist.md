# Spec: Documented surfaces that do not exist

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Status | `Active` |
| Created | `2026-08-29` |
| Last updated | `2026-08-29` |
| Roadmap phase | `none — correctness follow-up` |
| Tracking issue/PR | branch `fix/documented-surfaces` |
| Compatibility posture | Preserves compatibility for users, clean break for one unreachable internal module. `/help` is additive: a name that currently fails starts working, and no existing command changes. `buildToolContractSnapshot()` is additive: it replaces one inline re-derivation with a call, and no tool, contract, permission rule, or session format changes. The deletion is a clean break in name only — `src/server/create-harness.ts` is absent from `src/index.ts`, absent from the package `exports` map (which admits `.`, `./rpc-entry`, and `./client` only), and imported by nothing but its own test, so no consumer can reach it to break. |

## Executive summary

Three things this repository documents do not exist in it. `README.md` teaches `/help` as
the first command to run and no such command is registered. `AGENTS.md`, `CONTEXT.md`, ADR
0010 and seven other documents instruct every reader to route tool description through
`buildToolContractSnapshot()`, which has no implementation in any TypeScript file. And
`src/server/create-harness.ts` is reachable from nothing but its own test. This spec adds the
first two and deletes the third.

## Context and motivation

- `docs/adr/0010-one-canonical-tool-contract.md` — the accepted decision this implements. It
  names the projection as "the sole source for `/tools`, `/doctor`, generated reference docs,
  and the drift test", and states that a second independent classification "is the drift this
  ADR exists to prevent".
- `AGENTS.md` § Tools — instructs coding agents working in this repository: "Never re-derive a
  tool's capability, risk, or permission classification. One projection,
  `buildToolContractSnapshot()`, serves every surface that describes the tool registry." An
  agent that follows this instruction today finds nothing to call.
- `docs/specs/2026-08-18-lsp.md:114` — already records the gap in one line:
  "**`buildToolContractSnapshot()` does not exist, so this spec does not cite it.**" That is a
  workaround written into a spec, which is the signal that the absence has begun costing.
- `docs/architecture/contracts.md` § 1 — the contract shape the projection reads.

## Current state

**`/help`.** `README.md:197` lists `/help  Show interactive commands` as the first entry in
"Useful first-session commands". `core/slash-commands.ts:19` defines
`BUILTIN_SLASH_COMMANDS` with twenty-five entries and `help` is not among them.
`modes/interactive/interactive-mode.ts:3185` dispatches `/hotkeys` to
`handleHotkeysCommand`, which renders a markdown table into the chat container; there is no
equivalent for commands. The full command set — builtins plus prompt templates plus extension
commands plus skill commands — is assembled at `interactive-mode.ts:807` and handed to the
autocomplete provider, and exists nowhere else.

**`buildToolContractSnapshot()`.** Named in ten documents, implemented in none. The one
surface that describes rather than enforces is `main.ts:880`, which filters
`session.getAllTools()` on `tool.unclassified` to raise a startup diagnostic. That flag is
derived inline at `agent-session.ts:1108` as `unclassified: !("contract" in definition)`. The
enforcement paths are separate and stay separate: `context/pipeline.ts:82` and
`context/eviction.ts:86` both consume a `contractLookup` and apply their own conservative
default for a tool with no contract, which ADR 0010 explicitly permits because they enforce
rather than describe. None of the four consumers ADR 0010 names exists: there is no `/tools`,
no `/doctor`, no generated reference doc, and no drift test.

**`src/server/create-harness.ts`.** The only file in `src/server/`. It wraps
`AgentHarness` from `apex-code-agent-core` with four tools and a system prompt. It is not
re-exported from `src/index.ts`, the package `exports` map admits only `.`, `./rpc-entry`, and
`./client`, and the sole importer in the repository is
`test/server/create-harness.test.ts`. This is the second session store noted in the
2026-08-28 review of this repository, and the trace resolves to: the shipped CLI drives
`core/session-manager.ts` through `main.ts:707`, and this path drives nothing.

None of the three is forked Pi behaviour, so ADR 0003 merge cost does not apply.

## The problem

**1. The first command the README teaches fails.** A new user reads "Useful first-session
commands", types `/help`, and gets nothing. This is the worst possible position in the
document for a broken instruction, and the cost lands entirely on first-time users.

**2. An instruction to every coding agent cannot be followed.** `AGENTS.md` is read before
the first edit, by construction. It names a function to call and the function is not there,
so the reader either invents a second classification — the exact drift ADR 0010 was written
to prevent — or writes a workaround into a spec, which
`docs/specs/2026-08-18-lsp.md:114` shows has already happened once. The rule is sound; only
its mechanism is missing.

**3. Dead code reads as a live alternative.** A newcomer tracing session handling finds two
stores and cannot tell which one ships without running the trace to `main.ts`. The 2026-08-28
review recorded exactly that confusion and left it unresolved. Keeping an unreachable second
implementation costs a reader every time and buys nothing.

## Goals

- [ ] `/help` is registered, appears in autocomplete, and renders every command available in
      the session — builtin, prompt template, extension, and skill — asserted by a test that
      registers an extension command and finds it in the rendered output.
- [ ] `/help` and the autocomplete list are built from one function, asserted by a test that
      compares the two for the same session rather than by inspection.
- [ ] `buildToolContractSnapshot()` exists, returns one entry per registered tool carrying its
      four contract axes and whether it is unclassified, and is a pure read: calling it twice
      returns equal values and mutates nothing.
- [ ] The startup unclassified diagnostic at `main.ts:880` reads the snapshot rather than
      re-deriving the flag, asserted by the diagnostic still firing for a tool registered
      without a contract.
- [ ] The drift test ADR 0010 names exists: every tool in the default registry resolves to a
      declared contract, and any tool that does not is reported as unclassified rather than
      silently defaulted.
- [ ] `src/server/create-harness.ts` and its test are gone, and `npm run check` plus the full
      suite stay green, asserting nothing depended on them.

## Non-goals

- [ ] **Building `/tools` or `/doctor`.** ADR 0010 names them as future consumers of the
      snapshot, not as things this change owes. Adding two commands nobody asked for to
      justify a projection would invert the reason for building it. The snapshot ships with the
      two consumers that exist: the startup diagnostic and the drift test.
- [ ] **Routing the enforcement paths through the snapshot.** `context/pipeline.ts` and
      `context/eviction.ts` consume `contractLookup` and must keep doing so. ADR 0010 is
      explicit that nothing the snapshot returns is an authorization input, and moving an
      enforcement path onto a describing projection would break that boundary in the direction
      that actually matters.
- [ ] **Deleting `packages/agent`'s harness.** Only the unused `coding-agent` wrapper goes.
      `AgentHarness` is public API of `apex-code-agent-core`, exported from its index, and
      removing it is a different change with a different blast radius.
- [ ] **Generated reference docs.** The third consumer ADR 0010 names. It needs a docs
      pipeline that does not exist, and the snapshot is the prerequisite rather than the
      deliverable.
- [ ] **Changing any tool's declared contract.** This adds a reader, not a rule. If the drift
      test finds a tool that is wrong, that is a separate fix with its own reasoning.

## Proposed solution

Three units, independent, each landing in its own commit.

### A1 — `/help`

| Component | Change | File(s) |
| --- | --- | --- |
| Command | Register `help`, first in the table so it reads first | `core/slash-commands.ts` |
| Collection | Extract the command assembly currently inlined in the autocomplete builder | `modes/interactive/interactive-mode.ts` |
| Render | Dispatch `/help` to a handler shaped like `handleHotkeysCommand` | `modes/interactive/interactive-mode.ts` |

The extraction is the point rather than a tidy-up. Autocomplete and `/help` must show the
same commands, and the only way they cannot drift is that one function answers both.

### A2 — `buildToolContractSnapshot()`

| Component | Change | File(s) |
| --- | --- | --- |
| Projection | One entry per tool: name, four contract axes, `unclassified` | `core/tools/contract-snapshot.ts` (new) |
| Diagnostic | Read the snapshot instead of filtering on a re-derived flag | `main.ts` |
| Drift test | Every registered tool resolves to a declared contract or is reported | `test/tools/contract-snapshot.test.ts` (new) |

The projection calls the same predicate the registry uses and re-implements none of it, per
ADR 0010. It is a read: it takes the tools and returns a value, holds no state, and nothing it
returns reaches the permission gate.

**Seam invariant.** `beforeToolCall` is untouched. The snapshot is built from the registry
after tools are constructed and is never consulted during a tool call.

### A3 — Delete the unreachable harness wrapper

| Component | Change | File(s) |
| --- | --- | --- |
| Module | Delete, leaving `src/server/` empty and removed | `src/server/create-harness.ts` |
| Test | Delete with it | `test/server/create-harness.test.ts` |

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `packages/coding-agent/src/server/create-harness.ts` | code | removed. Unreachable: absent from `src/index.ts`, absent from the package `exports` map, imported only by its own test |
| `packages/coding-agent/test/server/create-harness.test.ts` | code | removed with the module it covers |
| `packages/coding-agent/src/server/` | code | removed; the deletion empties it |
| Inline `tool.unclassified` filtering at `main.ts:880` | code | superseded by `buildToolContractSnapshot()` |
| `docs/specs/2026-08-18-lsp.md:114`'s note that the projection does not exist | doc | superseded; the sentence stops being true and is corrected |

## Risks

**The snapshot becomes a second classifier rather than a projection.** This is the failure ADR
0010 names, and building the projection is exactly when it can be introduced. The design
constraint that prevents it: the snapshot reads the declared `contract` and the same
`unclassified` predicate the registry already applies, and computes no classification of its
own. The signal is any `if` in the snapshot module that inspects a tool's name, capability, or
risk to decide something; the drift test is what would surface the disagreement.

**`/help` drifts from autocomplete.** Two lists, one rendered and one completed, is how this
normally rots. Both read one function, and a test compares them for the same session rather
than trusting the arrangement.

**The deletion removes something a future reader wanted.** Git keeps it
(`git show <commit>:packages/coding-agent/src/server/create-harness.ts`), and the roadmap
records where it went. An unreachable module costs every reader now for a benefit nobody has
claimed.

## Verification

- `packages/coding-agent/test/tools/contract-snapshot.test.ts` — the projection and the ADR
  0010 drift invariant across the default registry.
- `packages/coding-agent/test/help-command.test.ts` — `/help` renders every command class and
  agrees with autocomplete.
- The full suite for A3: the assertion that the deletion is safe is that nothing else fails.
- `npx tsgo --noEmit` and `npm run check`.

This serves no roadmap phase gate, so there is no corpus metric to meet.

## Rollout

Needs `docs/plans/2026-08-29-documented-surfaces-that-do-not-exist.md`, because the three units
are independent and each needs its own status.

No ADR. A2 implements a decision ADR 0010 already settled rather than revisiting it, and the
one place this spec could have contradicted it — routing enforcement through the snapshot — is
declined in Non-goals for the ADR's own stated reason.
