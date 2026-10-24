# Spec: Cache miss causes

**Status:** Active

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-10-24 |
| Last updated | 2026-10-24 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility. `requestShape` is optional on an assistant message. A session written before this change has none, and its cache notices stay exactly what they are today: token shortfall, model switch, or idle time. No setting and no session entry type changes. |

## Executive summary

A cache miss notice will say when the harness changed the system prompt, the tool list, or an earlier message. Today the detector compares token totals, so a prefix edit that keeps the same total is invisible. The cause is computed from hashes recorded with the request, not from a second cache implementation.

## Context and motivation

- `packages/coding-agent/src/core/cache-stats.ts` already detects a shortfall against the previous turn's prompt tokens, with a 1,024-token floor, and records idle time and a model change. Measured on 2026-10-24: a follow-up with the same totals and a different system prompt returned no miss.
- `docs/specs/2026-10-24-bash-catastrophic-deny.md` is the other verified item from the Jcode comparison. It has landed. This is the remaining one.
- Jcode's `kv_cache_monitor.rs` hashes the system prompt, the tool set, and each message, then names `system_changed`, `tools_changed`, and `prefix_changed` as harness-caused. This spec records that behavior. It does not copy the monitor's types or wording.

## Current state

`detectMiss` subtracts `cacheRead` from the previous prompt size. A shortfall at or below 1,024 tokens is noise. The transcript notice names three causes: a plain miss, a model switch, and idle past five minutes. It stays quiet under 20,000 tokens and $0.10. Nothing in the request path hashes the prompt. An assistant message stores usage, model, and timestamp. It does not store the prompt shape.

## The problem

A change to the system prompt, the tool list, or an earlier message invalidates the provider cache and the bill goes up. The notice cannot tell that from a provider that simply did not read the cache. The failure is reproducible with two requests whose token totals match and whose system prompts differ: `detectCacheMiss` returns undefined.

## Goals

- [ ] A request records a hash of the system prompt, a hash of the tool list, and a hash per message, on the assistant message that comes back.
- [ ] When the previous request and this one both have those hashes, a miss names `system`, `tools`, or `prefix`. `system` wins over `tools`, and `tools` wins over `prefix`.
- [ ] A token-stable request whose system hash changed is reported as a miss with cause `system`, even though the token shortfall is below the noise floor.
- [ ] A session whose messages have no hashes keeps today's results. The existing cache tests pass without modification.
- [ ] The transcript notice uses the cause when one is present: "Cache miss after system prompt change", "Cache miss after tool list change", or "Cache miss after an earlier message changed".

## Non-goals

- [ ] Account switches, provider daily rollover, and OpenAI's larger block floor. Those need provider identity the session message does not carry. A later spec can add them.
- [ ] A new cache. The provider's reported `cacheRead` remains the measurement. The hashes only explain it.
- [ ] Grep output pruning. The read ledger stores a hash and a complete flag, not line ranges, so it cannot prune a grep result.

## Proposed solution

| Component | Change | File |
| --- | --- | --- |
| Request shape | Three hashes, recorded on the assistant message before it is persisted. | `packages/coding-agent/src/core/cache-stats.ts`, the message construction site in `model-runtime.ts` |
| Cause | Compare the new shape to the previous request's shape. | `packages/coding-agent/src/core/cache-stats.ts` |
| Notice | Prefer the cause over the idle and model labels when both exist. | `packages/coding-agent/src/modes/interactive/interactive-mode.ts` |

The hash is SHA-256 of the canonical JSON of each part, truncated to 16 hex characters. It is not reversible to the prompt text. A message with no recorded shape contributes nothing, and the comparison is skipped.

**Landed scope (2026-10-24).** The comparison and the notice label are in. The hash is read from an optional `requestShape` on the assistant message. Nothing writes that field yet. `model-runtime.ts` records usage after the provider returns, and the message it sees is the provider's message, which does not carry the request. Writing the hash at the stream boundary without a tested construction site would mark every turn or none. Until a writer lands, every real session takes the no-shape path and the notice is unchanged. The test supplies the shape directly, which is what pins the comparison.

## Deletion inventory

Nothing existing is removed. The notice gains a label. The token arithmetic is unchanged for messages without a shape.

## Risks

A hash that includes a timestamp or a random id will mark every turn as a prefix change. The test pins the hash inputs to the system text, the tool names and schemas, and the message content. A flapping hash shows up as a cause on every turn of a healthy session.

## Verification

- `packages/coding-agent/test/cache-stats.test.ts` gains one case: equal token totals, different system hash, cause `system`.
- The existing cases in that file stay green, which pins the no-shape behavior.
- `npx tsgo --noEmit` is clean.

No roadmap phase gate applies.

## Rollout

Small enough to implement directly. No plan doc. No ADR: the field is optional and the session format already accepts unknown fields on messages through the existing parser. If the parser rejects unknown fields, the shape is stored only in memory and the resume notice degrades to today's label. That fallback is acceptable and will be recorded here if it is what the code does.
