# Spec: A refusal that says "always" persists

**Status:** Draft

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Created | `2026-09-07` |
| Last updated | `2026-09-07` |
| Roadmap phase | `none — product-surface follow-up` |
| Tracking issue/PR | `found while writing pull request #90` |
| Compatibility posture | `Preserves compatibility for callers. Changes behavior for one existing ACP choice.` |

**Compatibility posture.** No type or signature changes. `PermissionAnswer.persist`
already exists and is already sent on a denial by the ACP bridge; the gate simply stops
discarding it. The behavior change is confined to the ACP `reject_always` choice, which
today does nothing beyond the single refusal and afterwards does what its name says. No
settings key, session file, or CLI surface changes shape. A session rule still ends with
the session.

## Executive summary

The ACP client is offered "Reject always" and the bridge maps it to
`{ allow: false, persist: true }`. The gate returns on any denial before it reads
`persist`, so no rule is ever written and the next identical call asks again. This makes
the gate honour `persist` on the denial branch, writing a session-source deny rule from
the tool's own `ruleForCall()`, exactly as it already does for an allow.

## Context and motivation

- `docs/specs/2026-09-07-ember-workflow-completion.md` records this defect. It was found
  while fixing two of the same class and deliberately left out, because the honest repair
  is a behavior change rather than a wording change.
- `docs/adr/0010` keeps rule authorship with the tool. This writes `ruleForCall()`
  unchanged and invents no grammar, which is the same constraint the allow path holds.

## Current state

`modes/acp/server.ts:34` offers `{ optionId: "reject-always", name: "Reject always", kind: "reject_always" }`.
`server.ts:146` resolves it to `{ allow: false, persist: true }`.

`core/permissions/gate.ts:124` returns `{ block: true }` for any answer whose `allow` is
false. The persist branch at line 127 is unreachable from a denial, so the flag is
discarded and no deny rule reaches the store.

The TUI responder offers no equivalent choice, so it is unaffected today.

## The problem

A label promises a standing refusal and delivers a single one. A user who picks "Reject
always" on a command they never want to see again is asked about it on the very next
call, and nothing on screen explains why. It is the same defect as the two corrected in
pull request #90, one branch further down: the code silently ignores what the label sold.

## Goals

- [ ] A denial carrying `persist` writes a session-source deny rule built from
      `ruleForCall()`.
- [ ] The next identical call resolves to deny from that rule, without asking.
- [ ] A denial without `persist`, and a denial whose tool yields no rule, write nothing.
- [ ] ACP offers `reject_always` only when a rule would actually be written, matching what
      pull request #90 already did for `allow_always`.

## Non-goals

- [ ] **No new choice in the TUI prompt.** The interactive prompt offers no standing
      refusal today. Adding one is a product decision about how easily a user should be
      able to wall off a tool, and it is not needed to stop the existing lie.
- [ ] **No persistence beyond the session.** Deny is written to the same `session`
      destination as allow. A refusal that outlived the session would be a new kind of
      state with its own removal problem.
- [ ] **No change to precedence.** `resolvePermission` already ranks deny over allow
      within a source. This writes a rule and changes no resolution logic.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Gate | Honour `persist` on the denial branch, writing `behavior: "deny"` from `ruleForCall()` before returning the block. | `core/permissions/gate.ts` |
| ACP | Filter `reject_always` out of the offered options when no rule would be written, alongside the existing `allow_always` filter. | `modes/acp/server.ts`, `main.ts` |

The write is the allow path's, with one field different. Destination stays `session`,
content stays `ruleForCall()`, and the tool remains the only thing that authors grammar.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| The unreachable `persist` on a denial | behavior | removed by making it reachable rather than by deleting the flag |

Nothing else is removed. The alternative repair was to drop the `reject_always` option
so the label stops lying by disappearing. That loses a protocol-standard choice an ACP
client is entitled to offer, to avoid writing eight lines that the allow path already
proves work.

## Risks

**A refusal is easier to create than to remove.** A user who rejects always by accident
has no prompt-level way to undo it, and the tool then refuses for the rest of the
session. The signal is a tool that stops working after one refusal. It is bounded by the
session destination, which is discarded on exit, and by the same rule surfaces that
already manage session allows.

**A deny rule is broader than the call that created it.** `ruleForCall()` returns what
would allow this exact call, so a deny built from it refuses exactly that call shape and
no more. That is the same breadth the allow path already grants, in the safer direction.

## Verification

Test-first, per `AGENTS.md`.

- Extend `test/permissions/` with a denial that persists, asserting the store receives
  `{ behavior: "deny", ruleContent }` at `destination: "session"`.
- Assert the next identical call resolves to deny from that rule without reaching the
  responder, which is the promise the label makes.
- Assert a denial without `persist` and a denial whose tool yields no rule write nothing.
- Extend `test/acp/server.test.ts` with the `reject_always` filter.
- Gates. `npx tsgo --noEmit`, the narrowest test file first, and `npm run check`.

## Rollout

Small enough to implement directly, with no separate plan document.
