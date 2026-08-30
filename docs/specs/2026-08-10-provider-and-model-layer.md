# Spec: provider and model layer

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | Fchery87 |
| Created | 2026-08-10 |
| Last updated | 2026-08-11 |
| Roadmap phase | 1 — Provider & model layer |
| Tracking issue/PR | none |
| Compatibility posture | **Preserves compatibility.** Existing provider configuration, `AuthStorage`, `ModelRuntime`, and Pi-compatible model identifiers continue to work. Roles, fallbacks, and credential selection are additive; legacy single-model selection remains the default when no role configuration is present. Keys are never migrated into a new plaintext file. |

## Executive summary

Phase 1 adds operational provider independence above the consumed `pi-ai` package. Apex Code will select credentials through a persistent pool with bounded failover, resolve named model roles through ordered fallback chains, and record enough per-request usage and latency data to make routing and cost claims measurable. The existing public provider registration and runtime seams remain the integration boundary; `pi-ai` is not forked or patched.

## Context and motivation

The Phase 0 replay runner now provides deterministic context, prompt, tool, cache, cost, and completion metrics (`packages/coding-agent/src/testing/replay/`). The roadmap requires the next layer to survive provider failures rather than treating one configured key/model as the provider abstraction. `packages/coding-agent/src/core/auth-storage.ts`, `model-runtime.ts`, `model-config.ts`, and `models-store.ts` already own credentials, model discovery, and runtime registration. The provider research in `docs/research/2026-08-08-harness-comparative-review.md` Finding 6 identifies credential pooling, roles, measured latency, and durable usage history as the relevant operational primitives. ADR 0001 keeps `pi-ai` and `pi-tui` consumed dependencies.

## Current state

- `AuthStorage` supports persisted credentials and in-memory test storage, but a turn resolves one credential rather than selecting from a health-aware pool.
- `ModelRuntime` loads model configuration and exposes `registerProvider()`, while the Agent session resolves one active model. There is no user-facing role/fallback graph.
- Provider retry utilities exist below the coding-agent layer, but retry/failover policy is not represented as a credential lease or recorded selection decision.
- `Usage` includes input/output/cache buckets and cost, and assistant messages carry timestamps, but latency and per-turn cost are not stored as durable routing data.
- Configuration loaders must not write secrets. Existing environment and credential-store reads remain valid.

## The problem

A rate-limited or expired primary credential can terminate an otherwise recoverable turn. A single default model also cannot express that planning, ordinary work, cheap classification, and design may have different latency/cost requirements. Without role fallback and measured request data, model choice is guesswork; without durable cost samples, Phase 8 cannot reconcile reported cost with provider billing.

## Goals

- [ ] A forced primary 429/blocked response selects a healthy secondary credential and completes the turn, with the selection and failure reason observable in structured test data.
- [ ] One configuration resolves distinct `default`, `plan`, `tiny`, and `designer` roles (plus extensible names), each with ordered model fallback candidates.
- [ ] Role fallback is bounded, preserves the original error when all candidates fail, and never loops through a candidate twice in one turn.
- [ ] Credential secrets are read from the credential store or environment and never emitted to a loader-written file, log, metric, or error.
- [ ] Per-request usage, cost, time-to-first-token, and generation duration are recorded against provider/model/role without changing the consumed `pi-ai` API.
- [ ] The Phase 0 replay corpus reports stable cost within 5% of its recorded provider cost, with zero network calls.

## Non-goals

- [ ] Forking or patching `pi-ai`, adding provider dialects, or duplicating provider model catalogs; provider-specific work goes through `registerProvider()` or upstream contribution.
- [ ] A general-purpose scheduler or distributed credential daemon; durable SQLite coordination belongs to Phase 6.
- [ ] Permission, sandbox, tool-schema eviction, or prompt-context policy; those remain later phases.
- [ ] Silently changing a user’s configured model or credential order; fallback is explicit, bounded, and recorded.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Credential pool | Add credential identity, cooldown/blocked state, refresh lease, deterministic rotation, and selection result. | `packages/coding-agent/src/core/auth-storage.ts`, new credential-pool module |
| Role resolver | Parse additive role definitions and ordered model candidates; preserve legacy default model resolution. | `packages/coding-agent/src/core/model-config.ts`, `model-resolver.ts` |
| Runtime failover | Wrap the existing stream boundary, classify retryable provider failures (429/auth-expiry/temporary transport), and retry only with a fresh credential/candidate. | `packages/coding-agent/src/core/model-runtime.ts`, `agent-session.ts` |
| Measurements | Capture request start, first event, completion/error, usage, model, provider, role, and credential identity (never secret). | new usage/performance recorder beside `usage-totals.ts` |
| Replay gate | Exercise forced failover and compare deterministic usage/cost output to the recorded fixtures. | `packages/coding-agent/test/`, `packages/coding-agent/src/testing/replay/` |

The runtime remains the sole provider boundary: all selection happens before or at
`ModelRuntime.streamSimple()`, and provider registration continues to use the public
`registerProvider()` seam. Credential identity is a non-secret stable label; raw keys
are write-only inputs to the provider call and are excluded from snapshots.

### Configuration shape

The additive shape is intentionally role-oriented and ordered:

```yaml
roles:
  default:
    models: [google/gemini-3-flash-preview, anthropic/claude-sonnet]
  plan:
    models: [anthropic/claude-sonnet, google/gemini-3-pro]
  tiny:
    models: [google/gemini-3-flash-lite]
  designer:
    models: [google/gemini-3-pro]
credentials:
  - id: primary
    provider: google
    source: env:GOOGLE_API_KEY
  - id: secondary
    provider: google
    source: env:GOOGLE_API_KEY_SECONDARY
```

The exact on-disk schema is finalized in the implementation plan and must accept
current model files unchanged. The `source` value is a reference, not a secret; a
loader must resolve it and never write its resolved value back.

## Deletion inventory

Nothing existing is removed — this is additive. Legacy single-model and credential
configuration remain the compatibility path while role and pool records supersede
only the selection decision at runtime.

## Risks

| Risk | Signal | Mitigation |
| --- | --- | --- |
| Retry repeats a non-idempotent provider operation | duplicate request or provider-side request id | classify only pre-completion retryable failures; bound attempts and preserve request metadata |
| A blocked credential is selected repeatedly | repeated 429/auth failures in one turn | cooldown/lease state and per-turn attempted-identity set |
| Cost tables drift | replay/provider reconciliation exceeds 5% | mark stale prices and preserve reported provider usage separately from estimates |
| A secret leaks through diagnostics | scrub test finds key-shaped text | stable credential IDs only; secret rejection tests over logs/config/metrics |

## Verification

Run focused credential-pool, role-resolution, failover, and usage tests in scratch
state; run the Phase 0 replay corpus twice and compare canonical JSON byte-for-byte.
The phase exit gate is a forced primary 429 rotating to a secondary, distinct role
resolution from one config, no loader-written secret, and cost within 5% of recorded
provider cost.

## Rollout

Needs `docs/plans/YYYY-MM-DD-provider-and-model-layer.md` because it spans credential
storage, runtime selection, configuration compatibility, and multiple provider/error
paths. No ADR is required at spec time; if the exact durable credential schema or
fallback semantics become irreversible, write the next free ADR before implementation.
