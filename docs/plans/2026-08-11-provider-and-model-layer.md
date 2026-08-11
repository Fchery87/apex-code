# Plan: Phase 1 — provider and model layer

> **For the implementing agent:** Read `AGENTS.md` first. ADR 0001 forbids patches
> to consumed `pi-ai`; every provider integration stays above its public APIs. ADR
> 0002 forbids reading or copying from `c-code`. Work test-first: write each named
> test, run it red for the expected missing behavior, implement the smallest vertical
> slice, then re-run it green. Any test that drives an Agent turn or writes a session
> must `chdir` to a fresh scratch directory first.

**Status:** active — implementation has not started ·
**Date:** 2026-08-11 · **Spec:** `docs/specs/2026-08-10-provider-and-model-layer.md`

**Goal:** Make a configured provider/model choice operationally resilient: a request
can rotate from a blocked credential to a healthy one, named roles resolve ordered
model candidates, failures are bounded and observable, and non-secret per-request
usage and latency become durable routing inputs.

**Architecture:** `ModelRuntime` remains the sole execution boundary above consumed
`pi-ai`. A credential-pool module selects an opaque credential identity immediately
before `ModelRuntime.stream()`/`streamSimple()` calls the registered provider. A role
resolver converts a named role into an ordered model-candidate chain without changing
legacy initial model selection. A separate non-secret operational-state store records
pool health, request outcomes, usage, and timing; it is injected in tests and file
backed in the CLI. `models.json` remains credential-blind: it may name models and
roles, but never contains a resolved secret.

**Tech stack:** TypeScript, Node >= 22.19.0, TypeBox, Vitest, existing
`CredentialStore`, `ModelRuntime`, and `registerProvider()` public seam. No `pi-ai`
or `pi-tui` modification; no network in focused tests or replay.

## Confirmed public seams under test

| Seam | Behavior proved | Why it is public enough |
| --- | --- | --- |
| `ModelRuntime.streamSimple()` | A retryable pre-completion primary failure rotates exactly once to a healthy secondary credential and completes. | This is the provider-facing API used by normal Agent turns. |
| `ModelRuntime` role resolution API (added in Task 1.4) | One config resolves ordered, distinct `default`, `plan`, `tiny`, and `designer` candidates while legacy selection is unchanged. | It exposes the new operational choice without coupling callers to a config parser. |
| `ModelRuntime` request-observation API (added in Task 1.6) | A completed or failed attempt records only non-secret model/role/credential identity, usage, and latency. | It is the observable data Phase 8 routing and diagnostics will consume. |
| Offline replay runner | Recorded cost remains within 5% of fixture provider cost and output remains byte-stable across two corpus runs. | The Phase 0 corpus is the project-wide measurable behavior boundary. |

Private modules are tested directly only where they are deliberately pure (pool
selection and configuration validation). Runtime integration tests remain the proof
that the actual provider boundary uses them.

## State and compatibility decisions

1. **Do not extend `CredentialStore` with a pool.** It is a consumed `pi-ai` interface
   whose contract is one credential per provider. Apex owns an adjacent pool adapter,
   passes the chosen credential as request-scoped authentication, and stores only an
   opaque `CredentialIdentity` in health/measurement records.
2. **No resolved secret persists outside the existing credential store or environment.**
   `models.json`, its catalog store, pool snapshots, metrics, errors, diagnostics, and
   session metadata contain an ID/reference only. Existing `providers.*.apiKey` values
   remain readable as the compatibility path (including legacy literals) but a loader
   never writes, copies, logs, or reserializes them. New pool credentials use only the
   credential store or environment references. Removing legacy literals needs a
   separately documented migration rather than a Phase-1 clean break.
3. **File-backed operational state is transitional and versioned.** Phase 1 writes a
   private, mode-0600 JSON operational-state file under the Apex agent directory,
   injected behind a store interface. It holds no raw credential and is deliberately
   replaceable by Phase 6 SQLite; it is not a second source of credential truth.
4. **Failover is pre-completion and finite.** A turn visits a `(credential identity,
   provider/model candidate)` at most once. Only classified rate-limit, expired-auth,
   and transient transport failures reached before a completion can advance. If the
   chain exhausts, rethrow the original failure with later attempts retained as
   non-secret diagnostics.
5. **Role fallback and credential rotation are separate dimensions.** For one role,
   attempt all eligible credentials for a model candidate before advancing to the next
   candidate. A role never revisits a candidate in a turn. Explicit CLI/session model
   selection remains authoritative unless a caller opts into role resolution.

If validation reveals that the operational-state format must become a public,
user-editable contract rather than a private cache, stop and write ADR 0011 before
implementing it. Do not make that compatibility decision implicitly.

## Task table

| # | Task | State | Commit(s) |
| --- | --- | --- | --- |
| 1.1 | Establish credential/config secrecy guard | not started | — |
| 1.2 | Add deterministic credential-pool selection | not started | — |
| 1.3 | Integrate bounded runtime credential failover | not started | — |
| 1.4 | Add additive role configuration and resolution | not started | — |
| 1.5 | Add bounded role-model fallback | not started | — |
| 1.6 | Record non-secret usage and latency | not started | — |
| 1.7 | Prove replay cost and determinism gate | not started | — |
| 1.8 | Close Phase 1 | not started | — |

## Task 1.1 — Establish credential/config secrecy guard

**Files:** `packages/coding-agent/src/core/model-config.ts`, relevant config/provider
composition code, `packages/coding-agent/test/model-config.test.ts`, and a focused
secret-regression test.

1. Add failing tests that load legacy provider-only `models.json` unchanged, including
   a legacy literal sentinel and `$ENV`/command references. Assert that read-only
   loading never writes a file, logs or serializes the literal, or copies a resolved
   environment sentinel into the model/catalog files.
2. Run the narrow test and observe the output/secrecy assertion fail where the current
   path has no explicit regression guard.
3. Preserve the existing compatibility read path while validating new role/pool inputs
   separately. Do not log the offending value and do not add any new literal-key
   configuration shape.
4. Re-run focused tests, then `npx tsgo --noEmit`.

**Done when:** existing provider configuration continues to load, the loader writes no
configuration, and literal/resolved sentinel secrets are absent from all new or
loader-generated output.

## Task 1.2 — Add deterministic credential-pool selection

**Files:** new `packages/coding-agent/src/core/credential-pool.ts`, an injected
non-secret operational-state/store module, and
`packages/coding-agent/test/credential-pool.test.ts`.

1. Write pure failing tests with a fake clock for stable initial selection, rotation,
   blocked/cooldown exclusion, refresh-lease ownership, lease release, and no repeated
   opaque identity in one attempt set. Assert serialized selection/failure data never
   contains the sentinel key.
2. Run only `credential-pool.test.ts`; it should fail because the module does not
   exist.
3. Implement `CredentialIdentity` as a branded non-secret label and a total pool API:
   select, mark failure, mark success, acquire/release refresh lease, and take a
   diagnostic snapshot. Use the injected state store; do not mutate `auth.json` into
   an incompatible multi-key `CredentialStore` shape.
4. Re-run the focused test and typecheck.

**Done when:** pool behavior is deterministic under a fake clock, blocked identities
are not reselected, one turn cannot use an identity twice, and every observation is
secret-free.

## Task 1.3 — Integrate bounded runtime credential failover

**Files:** `packages/coding-agent/src/core/model-runtime.ts`, runtime credentials or
new adapter module, `packages/coding-agent/test/model-runtime-failover.test.ts`.

1. First write a scratch-directory integration test using a registered native fake
   provider. Its primary opaque credential returns a classified 429 before completion;
   the secondary returns a completed stream. Assert the public
   `runtime.streamSimple()` succeeds, attempts occur primary then secondary exactly
   once, and the structured outcome exposes only identities and the failure class.
2. Run it red; the current runtime makes exactly one request.
3. At the runtime request seam, select request-scoped auth, classify retryable
   pre-completion failures, record the result, and advance within a bounded candidate
   set. Preserve the original failure after exhaustion. Do not add a second
   post-message retry loop or patch `pi-ai`.
4. Add all-fail, cancellation, non-retryable, and duplicate-prevention cases. Re-run
   the focused suite and the existing credential synchronization tests.

**Done when:** the Phase 1 forced-429 criterion passes through the real stream seam,
with no infinite loop, duplicated completed request, raw key diagnostic, or regression
in ordinary one-credential provider calls.

## Task 1.4 — Add additive role configuration and resolution

**Files:** `packages/coding-agent/src/core/model-config.ts`,
`packages/coding-agent/src/core/model-resolver.ts`, `model-runtime.ts`, exports, and
`packages/coding-agent/test/model-roles.test.ts`.

1. Write failing tests for a comment-tolerant `models.json` whose optional top-level
   `roles` maps a role name to an ordered non-empty list of canonical
   `provider/model` references. Prove `default`, `plan`, `tiny`, and `designer` can
   resolve differently, custom names work, and a legacy file leaves existing initial
   selection unchanged.
2. Run red. Implement schema validation and an explicit runtime role-resolution API
   returning ordered models plus structured configuration diagnostics; it must not
   resolve credentials or write configuration.
3. Reject empty chains, malformed references, duplicate candidates, and unknown model
   references without a cast or silent fallback.
4. Re-run role/model-resolver suites and typecheck.

**Done when:** one configuration expresses the four named roles plus extensions;
legacy single-model selection is byte-for-byte behaviorally unchanged when roles are
absent.

## Task 1.5 — Add bounded role-model fallback

**Files:** `packages/coding-agent/src/core/model-runtime.ts`, possibly the role
resolver, `packages/coding-agent/test/model-runtime-failover.test.ts`.

1. Add a red integration test where every eligible credential for a role's primary
   model gets a classified pre-completion failure and its next model candidate
   completes. Assert candidate order, no repeated credential/model pair, original
   error preservation if all fail, and no fallback for non-retryable errors.
2. Implement this atop Task 1.3's single attempt runner, not as a parallel retry
   system. Expose opt-in role execution so explicit selected models retain existing
   semantics.
3. Re-run focused failover and role suites plus `agent-session-retry.test.ts`.

**Done when:** fallback is finite, deterministic, and observable, and the old
AgentSession retry behavior neither masks nor multiplies runtime attempts.

## Task 1.6 — Record non-secret usage and latency

**Files:** new usage/performance recorder and store modules beside
`usage-totals.ts`, `model-runtime.ts`, exports, and
`packages/coding-agent/test/usage-performance-store.test.ts`.

1. Write failing tests with an injected clock/stream for time-to-first-token,
   generation duration, provider/model/role, credential identity, usage, cost, and
   outcome. Add a file-store round-trip in a temporary directory and assert no
   sentinel credential text appears on disk, in errors, or in snapshots.
2. Implement a versioned, 0600 file-backed operational-state store and in-memory test
   implementation. Record one sample per request attempt; use a stable monotonic
   timing source at runtime and injected values in tests. Do not write session entries
   or alter the Phase 0 replay format.
3. Re-run focused tests and `usage-totals`/runtime suites.

**Done when:** successful and failed attempts leave durable, non-secret data sufficient
for future measured routing, with no need to modify `pi-ai` or infer latency later.

## Task 1.7 — Prove replay cost and determinism gate

**Files:** replay tests and only those replay metric/fixture files necessary to expose
recorded-provider cost reconciliation.

1. Write a red assertion against the existing offline corpus that compares recorded
   fixture provider cost and replay-reported cost per corpus result, allowing at most
   5%, and keeps canonical corpus output equal across two consecutive runs.
2. If it fails, fix the Apex-side accounting or make any newly included metric
   deterministic; do not contact live providers or change fixtures merely to satisfy
   the threshold.
3. Run `npm --workspace packages/coding-agent test -- test/replay-runner.test.ts`
   twice, then the complete coding-agent test suite and `npx tsgo --noEmit`.

**Done when:** replay is offline, costs reconcile within 5%, and two canonical corpus
runs are byte-identical.

## Task 1.8 — Close Phase 1

1. Run the forced-429 failover, role-resolution, secret-regression, performance-store,
   and replay suites from scratch state. Run `npx tsgo --noEmit`, the package build,
   and `npm test`; record real output and distinguish inherited failures from new ones.
2. Verify each commit SHA before placing it in this table with
   `git cat-file -t <sha>`. Mark a task done only after its stated verification passes.
3. Update `docs/roadmap.md` with the real Phase 1 state and measured gate outcome.
   Update the Phase 1 spec status/rollout if implementation established an ADR or
   changed a documented compatibility posture.
4. Delete this plan in the same closing documentation commit, per `AGENTS.md`.

## Order changes

None. Task 1.1 precedes any new state because it establishes the secret boundary that
all subsequent pool/config/measurement work could otherwise violate. Task 1.2 is pure
and establishes the selection invariant before Task 1.3 makes real provider requests;
role and metric work build on that verified seam.
