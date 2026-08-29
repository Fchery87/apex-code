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
| DS.1 | A1 | Done | `pending` |
| DS.2 | A2 | Not started | — |
| DS.3 | A2 | Not started | — |
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
