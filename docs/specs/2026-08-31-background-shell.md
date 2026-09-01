# Spec: Background shell execution with a handle

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-08-31 |
| Last updated | 2026-08-31 |
| Roadmap phase | none (boundary-gap follow-up; see `docs/research/2026-08-31-harness-landscape.md`) |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility — additive optional schema fields (see below) |

**Compatibility posture:** additive. The `bash` schema gains optional fields and
two new call shapes; every existing call (command + optional timeout) behaves
byte-for-byte as before, no settings key is introduced, and the session format
is untouched (tool params are data). The schema ships in the release as a
normal versioned change to the prompt prefix — no conditional registration is
involved, so the within-version byte-identical-prefix property is not in play.

## Executive summary

The `bash` tool takes a command and an optional timeout, and that is all: a dev
server, a long build, or a slow test run occupies the turn until it exits or
times out. This adds `background: true` to the launch shape and handle-based
retrieve and kill shapes, mirroring the pattern delegation already ships —
launch returns immediately with a handle, retrieval returns the accumulated
output and running/exited status, kill terminates the process tree. Delegation
proved the model; the shell needs it more.

## Context and motivation

- `docs/research/2026-08-31-harness-landscape.md` § 3 and § 5 — the audit found
  background shell absent while delegation already models background work with
  handles; ranked #2 in the boundary-gap queue after declarative hooks (now
  landed, `a9675e1ce`).
- `docs/specs/2026-08-14-delegation-and-multi-agent.md` — the handle/retrieve
  pattern this mirrors: `backgroundByRuntime` WeakMap keyed on the runtime
  options object, `handleId` on the result, `retrieveDelegationResult`, and the
  deliberate lifetime rule that "results deliberately stay available for the
  lifetime of their parent runtime" (`core/delegation/runtime.ts:86-98`).
- `docs/adr/0024-per-command-sandbox-escalation.md` — escalated commands run in
  a supervisor-owned second child; this design must state how background
  interacts with that (see Non-goals).

## Current state

- `core/tools/bash.ts:130-133` — the schema is exactly `command` plus optional
  `timeout` (seconds). No background flag, no handle, no kill.
- The execution plumbing already spawns detached children:
  `detached: process.platform !== "win32"` with `waitForChildProcess`
  (inherited-stdio-safe) and a detached-child PID registry
  (`trackDetachedChildPid` / `untrackDetachedChildPid` / `killProcessTree`,
  `utils/shell.ts`) that the abort and timeout paths already use.
- Output is accumulated by `OutputAccumulator` with line/byte truncation and
  full-output persistence to a temp file (`details.fullOutputPath`) — the exact
  substrate retrieval needs.
- Execution is pluggable (`BashOperations.exec`, used for SSH-style backends),
  but `exec` is await-to-completion; there is no spawn-without-await variant.
- On a nonzero exit that looks like a sandbox refusal, the tool offers the
  command to the supervisor post-hoc (`escalateRefusedCommand`,
  `bash.ts:578-604`) — a synchronous flow that happens after the run completes.
- Delegation's background results live only for the parent runtime's lifetime;
  there is no cross-restart durability (deliberate, recorded in the delegation
  spec).

## The problem

Any workflow involving a long-running process stalls the agent: a dev server to
hit with `web_fetch`, a full build before reviewing its warnings, a test suite
longer than the model's patience. The model's only moves are to block on the
command or to time it out blind. Delegation can run work in the background and
retrieve it; the shell, which needs this more, cannot.

## Goals

- [ ] `bash` gains three call shapes: launch (`command`, optional `background:
  true`, existing `timeout` ignored when background), retrieve (`{ handle }`),
  and kill (`{ handle, kill: true }`) — one tool, mirroring `delegate`'s union
  schema.
- [ ] A background launch passes the permission gate exactly as today (same
  rule matching on the full command), returns immediately with a handle and
  running status, and the turn continues.
- [ ] Retrieval returns the accumulated output under the identical truncation
  and `fullOutputPath` rules as foreground runs, plus running/exited status;
  it is non-destructive and repeatable.
- [ ] Kill terminates the process tree (`killProcessTree`); a later retrieval
  reports the termination.
- [ ] Running background children are killed when the session disposes — no
  orphans; the registry's lifetime is the session's, mirroring delegation's
  runtime-lifetime rule.
- [ ] Evidence keeps recording the originating command: `capture` reads the
  registry on retrieve/kill calls so the record shows the command that produced
  the output, not a bare handle.
- [ ] With `background` unused, behavior is unchanged: no registry growth, no
  output-path differences on foreground runs.

## Non-goals

- [ ] A separate background-shell tool. The tool-budget discipline that
  declined a notebook tool applies; riding `bash` keeps the prefix at
  seventeen built-ins and reuses its permission grammar and evidence.
- [ ] Streaming background output into the transcript — settled: there is no
  surface to stream into. `onUpdate` renders a live tool call whose `execute`
  has not returned, and a background launch has returned by definition;
  delivering updates afterwards would mean injecting transcript entries from
  outside the loop, a new mechanism that strains the "the agent loop settles"
  invariant (`docs/architecture/overview.md`, inherited invariants) for
  something on-demand retrieval already covers. Polling is the v1 interface.
- [ ] Cross-restart durability of handles or outputs. Registry lifetime is the
  session's, mirroring delegation's recorded boundary; a keep-it-running
  workflow (`nohup`/daemon) remains the user's explicit move.
- [ ] Interactive escalation inside a background run — settled: the offer is
  delivered asynchronously, not skipped. ADR 0024's shape is
  offer-on-observed-refusal: the command must run, hit a kernel refusal, and
  only then is it offered, with the concrete refused path, to the supervisor.
  A background command cannot block on that offer mid-run without stalling the
  very turn it just returned from, and escalating proactively — asking before
  any refusal is observed — would change the security posture, not add a
  convenience. So a background refusal carries the refusal text plus the
  instruction that a foreground rerun gets the offer: the same composition,
  delivered where the model can act on it.
- [ ] Non-local backends — settled: `spawnBackground` is an optional
  `BashOperations` method, and backends without it reject `background: true`
  with a model-readable error naming the limitation. Making the method
  mandatory would break every existing implementor against this spec's
  additive posture, and the only silent alternative — running the command
  foreground while the model believes it is backgrounded — is disqualifying
  on its face.
- [ ] Windows job-object semantics beyond the existing `killProcessTree` path.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Schema | `Type.Union` of launch (`command`, `timeout?`, `background?`), retrieve (`handle`), kill (`handle`, `kill: true`), mirroring `delegate`'s two-variant union | `core/tools/bash.ts` |
| Registry | `createBackgroundShellRegistry()`: handle → entry (`pid`, command, startedAt, `OutputAccumulator`, exit promise); `retrieve`, `kill`, `dispose` (kills all running); injected via `BashToolOptions.backgroundRegistry` so tests script fakes | `core/tools/background-shell.ts` (new) |
| Local backend | New optional `BashOperations.spawnBackground(command, cwd, { env, onData })` returning `{ pid, exited: Promise<number \| null> }` alongside `exec`; implemented for the local shell with the existing detached spawn + PID tracking | `core/tools/bash.ts` |
| Evidence | `contract.evidence.capture` resolves retrieve/kill params through the registry to the originating command | `core/tools/bash.ts` |
| Session lifetime | The session that creates the tool owns the registry and calls `dispose` alongside its existing cleanup path | `core/agent-session.ts` wiring |

Permission behavior is unchanged at launch: the full command text is matched
against bash rules exactly as a foreground call, so nothing runs that the gate
would not have approved synchronously. The registry is keyed per tool
instance, and done entries retain their accumulator for the session's lifetime
— bounded by the same output caps as foreground runs.

Permission grammar for retrieve and kill (settled): they perform no new
execution — the command they operate on was already gated at launch — so they
default to allow when no rule matches. `PermissionSpec` gains an optional
`defaultBehaviorFor(params)` that the rule engine consults in its no-rule
fallthrough (`rules.ts`); mode floors and matching rules still outrank it. Handle
calls match the reserved rule content `background-handle`, so a
`Bash(background-handle)` rule (allow or deny) governs them explicitly and
`ruleForCall` persists that content for "always allow". Launch params hit the
existing segment grammar unchanged.

## Deletion inventory

Nothing existing is removed — this is additive. The foreground path, its
escalation offer, and `BashOperations.exec` are untouched; the only behavioral
delta behind an unused flag is the registry's existence, which holds no state
until a background launch happens.

## Risks

- **Orphaned processes.** A background child outliving the session is exactly
  the failure the dispose-kill goal exists to prevent. Signal: a test that
  launches `sleep 300` in the background, disposes the session, and asserts the
  process is gone.
- **Output flooding between retrievals.** A chatty server can generate
  megabytes between polls. Bounded by the existing `OutputAccumulator`
  caps and temp-file persistence; retrieval applies the same truncation.
- **Model confusion on stale handles.** Retrieving an unknown or
  already-collected handle must fail with a clear, model-readable message
  naming the valid handle set, never with a generic tool error.
- **Silent escalation skip.** A background run that refuses must say in its
  retrieved output that the escalation offer comes from a foreground rerun —
  the model should never learn this by trying and failing.

## Verification

- New vitest suite for the registry: launch → poll running → retrieve output →
  exit status; kill mid-run (POSIX-guarded spawn cases, mirroring the
  declarative-hooks suite's platform guard); dispose kills running children;
  unknown-handle error text.
- Schema and evidence tests: retrieve/kill produce evidence records carrying
  the originating command; launch records are unchanged from today's.
- Wiring test mirroring `test/checkpoints/session-wiring.test.ts`: a session
  with a background launch, dispose, then assert the child process is gone.
- Full `npm test` as the closing gate, per the declarative-hooks precedent.

## Rollout

Small enough to implement directly — one schema union, one new module, one
backend method, one session wiring line — so no separate plan doc beyond the
task table this implies; follow the declarative-hooks slice pattern (spec →
plan → test-first → full suite) when it is scheduled.
