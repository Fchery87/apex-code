# Phase 10 complete Apex Code product surface

**Status:** Active — 5 done, 1 implemented awaiting CI, 1 pending closure

This plan implements `docs/specs/2026-08-16-complete-apex-product-surface.md`. Task 10.1
establishes the known failing baseline. Task 10.2 centralizes environment identity
before live help and shipped docs consume it. CI is made required only after all current
platform blockers are repaired; task numbers are identifiers, and any changed execution
order is recorded below rather than renumbered.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| 10.1 External-editor argv and Apex identity | Done | `dc25d9438` | Failing-first native tests for spaced/quoted executable and arguments, invalid input, success/failure/empty outcomes; direct spawn; Apex resume text/temp prefix. |
| 10.2 Canonical environment compatibility | Done | `dc25d9438` | One registry/module for every Apex-owned legacy variable; table tests for precedence, warnings, internal writes, subprocess exports, and JSON/RPC stdout. |
| 10.3 Live runtime and packed npm product surface | Done | `dc25d9438` | Help/auth/update/trust/system-prompt/runtime strings corrected; npm README/current docs/path/privacy/container guidance corrected; packed-artifact allowlist test. |
| 10.4 Install, update, changelog, and release coherence | Done | `dc25d9438` | npm `next` remains authoritative; no upstream binary fallback; Apex current changelog; publishing constrained to Apex-owned packages; release-script tests. |
| 10.5 Documentation lifecycle repair and validator | Done | `dc25d9438` | Phase 4 measurement moved to spec, completed plan deleted, roadmap fixed, session contract settled; validator wired into check. |
| 10.6 Cross-platform blockers and required spaced-checkout CI | Implemented — local verification green; required CI proof pending | `dc25d9438` | License-report and any subsequent native failures fixed test-first; action SHAs pinned; matrix required; actual cwd contains a space; workflow structure test. |
| 10.7 Phase verification and closure | Not started | — | Typecheck/build/check/root full suite green locally; real required three-OS run green; durable closure moved to spec/roadmap and this plan deleted. |

## Order changes

None yet.

## Task 10.1 — external-editor argv and Apex identity

### Red

1. Extend `test/external-editor.test.ts` through `editInExternalEditor` so the fixture's
   executable/script/capture/fixed arguments exercise spaces and quoting deliberately,
   not only accidentally through this repository path.
2. Cover empty/malformed command input and exact argv, plus existing successful,
   nonzero, and cleared-content behavior.
3. Preserve private temporary-directory and cleanup assertions under the Apex prefix.

### Green

Normalize the string setting to executable plus args and spawn directly with the prompt
path appended as one final argument. Return a clear failed result for invalid commands.
Do not construct a shell command containing user text and the prompt path.

## Task 10.2 — canonical environment compatibility

### Red

Add an exhaustive owned-variable registry test and per-entry behavior matrix. Prove
canonical precedence, one warning for legacy-only reads, no warning from Apex's internal
compatibility writes, and dual subprocess metadata during the compatibility window.

### Green

Implement the smallest shared resolver/export interface and migrate Apex-owned callers.
Help/docs projections consume registry metadata where practical rather than copying a
second independent inventory.

## Task 10.3 — live runtime and packed npm product surface

### Red

Add focused help/diagnostic/system-prompt tests and a package-surface test over the files
included by `npm pack`. Use an explicit allowed-classification fixture for upstream,
historical, and compatibility Pi references.

### Green

Correct current product strings and rewrite the shipped package front door/current docs.
Delete the Pi installer recommendation and false telemetry claims. Do not rewrite
attribution history or compatibility interfaces.

## Task 10.4 — install, update, changelog, and release coherence

### Red

Extend package-command/release tests to assert Apex-only commands, npm `next`, no Pi
binary download fallback, Apex-versioned current changelog data, and a publisher set of
exactly the two Apex-owned packages in dependency order.

### Green

Make npm the coherent supported distribution. Retain disconnected binary builders only
as developer tooling without user-facing update claims.

## Task 10.5 — documentation lifecycle repair and validator

### Red

Write a deterministic script test using fixture docs for missing status, completed plan,
broken roadmap plan link, missing deletion inventory, and summary/section status drift.

### Green

Migrate the Phase 4 measurement, delete its plan, update the roadmap, settle contracts
§3, and wire the validator into `npm run check`.

## Task 10.6 — cross-platform blockers and required spaced-checkout CI

### Red

Reproduce or fixture the license-report path-separator/canonicalization issue without
assuming POSIX separators. Add a workflow parser test for immutable action refs, no
advisory matrix, all three OS values, explicit spaced checkout, and executed cwd proof.

### Green

Repair each blocker, pin actions, relocate the matrix checkout, and remove advisory
semantics. Windows sandbox exclusions remain unchanged and explicit.

## Task 10.7 — phase verification and closure

Run the narrow suites, `npx tsgo --noEmit`, `npm run build`, `npm run check`, and root
`npm test`. Push only when appropriate to obtain a real required three-OS run. Record
exact commands/results and the real run URL; do not mark CI-only claims locally verified.
Move durable results into the spec and roadmap, verify every recorded SHA with
`git cat-file -t`, then delete this completed plan.

## Shared implementation rules

- Test first and observe the right failure before implementation.
- Tests that write sessions/state use scratch directories and never repository state.
- Do not edit consumed packages to reduce Pi strings or environment names.
- Do not access `c-code`; research descriptions are the only permitted channel.
- Do not change either hosted-service default; Phase 11 owns that decision.
- Do not record “green on three OSes” without a real required CI run.
