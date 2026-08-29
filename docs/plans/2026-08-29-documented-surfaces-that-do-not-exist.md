**Status:** Active

# Documented surfaces that do not exist — implementation plan

**Goal:** `/help` works, `buildToolContractSnapshot()` exists and has the two consumers ADR
0010 names that are actually wanted, and the unreachable harness wrapper is gone. Every
sentence this repository writes about these three is true when the plan closes.

**Spec:** `docs/specs/2026-08-29-documented-surfaces-that-do-not-exist.md`

**Architecture:** Three independent units. A1 and A3 touch no shared surface and could land in
either order. A2 is the only one with a design decision in it, and its risk is building a
second classifier while intending to build a projection, so its drift test lands with it rather
than after.

**Tech stack:** TypeScript, Vitest.

## Task table

| Task | Unit | Status | Commit |
| --- | --- | --- | --- |
| DS.1 | A1 | Done | `d32061c9c` |
| DS.2 | A2 | Done | `pending` |
| DS.3 | A2 | Done, one invariant owed — see below | `pending` |
| DS.4 | A3 | Not started | — |

Order is load-bearing in one place. DS.2 and DS.3 land together: a projection without the
drift test is the shape ADR 0010 warns about, because nothing then proves the snapshot and the
registry agree.

### DS.1: `/help`

Register `help` at the top of `BUILTIN_SLASH_COMMANDS`, extract the command assembly currently
inlined in the autocomplete builder, and dispatch `/help` to a handler shaped like
`handleHotkeysCommand`.

The extraction is the substance. Two lists that must agree, built in two places, is how this
rots; one function answering both is the only arrangement that cannot drift.

**Done when:** `/help` renders builtin, prompt, extension, and skill commands, and a test
compares the rendered set against the autocomplete set for the same session.

### DS.2: The projection

`core/tools/contract-snapshot.ts`. One entry per registered tool: name, the four contract axes,
and `unclassified`. Pure read, no state, nothing it returns reaches the permission gate.

Point `main.ts`'s startup diagnostic at it, replacing the inline `tool.unclassified` filter.
That is the consumer that makes the projection real rather than speculative.

**Done when:** the diagnostic still fires for a tool registered without a contract, and the
snapshot is equal across two calls.

### DS.3: The drift test

The test ADR 0010 names. Every tool in the default registry resolves to a declared contract,
and anything that does not is reported as unclassified rather than silently defaulted.

**Done when:** the test passes on the current registry and fails if a tool is registered
without a contract.

### DS.4: Delete the unreachable harness wrapper

Delete `src/server/create-harness.ts` and `test/server/create-harness.test.ts`, leaving
`src/server/` removed.

The verification for a deletion is that nothing else breaks, so this one is proven by the full
suite rather than by a new test.

**Done when:** `npm run check` and the full suite are green with both files gone.

### Order change

DS.2 grew one step the plan did not anticipate, and it is the step that makes the projection
worth having. `getAllTools` derived `unclassified` with its own `!("contract" in definition)`
check. Pointing only `main.ts` at the snapshot would have left two derivations of the same
fact in two files, which is the drift ADR 0010 names even while they agree. The predicate is
now exported from the snapshot module and both call it.

### Owed: ADR 0010 invariant 5

The ADR describes a registry-wide property test for `ruleContent`: the tool owns both
matching a rule and generating one, "so the two cannot drift, which invariant 5 tests as a
property across the whole registry". That test is **not** delivered here.

It needs a valid sample `params` per tool. Every tool's grammar reads different fields, so a
shared stub exercises none of them, and a hand-written table for nineteen tools rots faster
than it catches anything. The honest version is a generator over each tool's typebox schema,
which is its own change. Recorded rather than faked: a passing stub here would have read as
coverage and been worse than the gap.
