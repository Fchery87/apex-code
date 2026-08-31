# Apex Code — roadmap

*A provider-agnostic agentic harness forked from Pi.*

**Status:** Active — Phases 0 through 12 landed · **Created:** 2026-08-08 · **Last updated:** 2026-08-23

> **Name settled: `apex-code`.** Binary `apex-code`, config directory
> `~/.apex-code/`, session paths, and the npm package name. Task 0.1 verified the npm
> coordinate is now claimed; token-free Trusted Publishing was proven by the published
> `0.0.1-alpha.1` prerelease. The bootstrap token is revoked, and both packages
> disallow token-based publishing.

This is the **program** document: what gets built, in what order, and the measurable
condition each phase must satisfy to be considered done. It is permanent and
status-tracked.

It is deliberately **not** an execution breakdown. Per `AGENTS.md` § Plan Documents,
each phase gets its own `docs/specs/YYYY-MM-DD-<slug>.md` (written when the previous
phase exits) and `docs/plans/YYYY-MM-DD-<slug>.md` (written when that spec is
approved, deleted on completion). Nine speculative plan docs written today would all
be wrong by Phase 3.

---

## Founding decisions

| Decision | Choice | Consequence |
| --- | --- | --- |
| Fork depth | Fork `pi-coding-agent` + `pi-agent-core`; consume every other Pi package | Full control of loop, tools, permissions, sessions. 35 providers keep updating for free. Provider work rides `registerProvider()`. Implemented as a full-tree graft with the consumed packages frozen and CI-asserted — see ADR 0001's amendment. |
| Target bar | Distributable OSS product | Versioned releases, install/update, docs, **session-format back-compat**, security posture, opt-in telemetry. Constrains every phase, not just Phase 9. |
| Thanos disposition | Evidence capture in core; SpecEngine + governance policy stay a bundled extension | Evidence recorded at the source (the bash tool knows its own exit code). Policy layer stays independently testable and switchable-off. |
| License | MIT (Pi is MIT across the whole monorepo; Thanos is already MIT) | Attribution required. Clean to distribute. |
| Name | **Apex Code**, identifier `apex-code` | Binary `apex-code`, config dir `~/.apex-code/`, repo `Fchery87/apex-code`. Bare `apex` was rejected: the npm coordinate is held by an abandoned 2022 stub (`v0.1.2`, "Work In Progress", untouched since 2022-06-13), which would have forced a scope and left users installing one name and running another. |
| npm coordinate | `apex-code` — **unscoped, verified free** | No scope needed, so the install command and the binary match. Claim it before first publish (Task 0.5); until then this is reversible. |

---

## Ground rules

**1. Clean-room with respect to `c-code`.** The leaked Claude Code source is
`UNLICENSED`. It is a **specification of behavior**, never a source to copy from.
No file, function, string, or type definition moves from it into this repo. It must
not be checked out in the build environment or in any agent's working tree during
implementation. Descriptions of its behavior in `docs/research/` are fine and are how
its ideas legitimately enter the project. This is ADR-0002 and it is the single
constraint most likely to be violated by accident under time pressure.

**2. Upstream is a dependency relationship, not a one-time copy.** Pi ships fast, and
Phase 0 measured how fast: one *patch* release moved 57 files and ~2,000 lines inside
the two packages we fork. A fork without merge discipline is dead in two months.
ADR 0003 sets the cadence, the ceiling, and the abandonment tripwires.

**3. Every phase exits on a number, not a feeling.** The strongest thing in the
current Thanos docs is the `≥50% keeps src/spec/` gate. Every phase below carries a
criterion someone other than the author can check. Where a threshold depends on a
baseline that does not exist yet, it is marked **Phase 0 baseline: 1,117 tokens**
(median turn-20 context across the three turn-20-capable corpus fixtures: 752
compacted, 1,117 un-compacted, 15,272 tool-heavy) rather than invented here. Measured
2026-08-13 via `replayCorpus()`; it was 935 over two fixtures until
`long-tool-heavy.jsonl` was added to make tool-result eviction measurable at all.

**4. Safety floor and context budget precede capability.** Permissions (2) and
context engineering (3) both gate the tool surface (4). Adding tools first means
retrofitting permissions one tool at a time, and shipping a harness that is more
capable and measurably worse.

---

## Phase map

```
0  Fork foundation ──┬──► 1  Provider & model layer
                     │
                     ├──► 2a Permissions: rule model ┐
                     │    2b Permissions: sandbox    ├──► 4  Tool surface ──► 5  Delegation
                     └──► 3  Context engineering ────┘
                                                          │
   6  Durable state & daemon ──────────────────────────────┘
   7  Evidence & verification      8  Observability & cost      9  Release hardening
```

| Phase | Name | State | Spec | Plan |
| --- | --- | --- | --- | --- |
| 0 | Fork foundation | **landed** — 10 of 10 tasks · `9d79cc6c6b` | [spec](specs/2026-08-08-fork-foundation.md) | — |
| 1 | Provider & model layer | **landed** — 7 of 7 tasks · `ad79a98fe` | [spec](specs/2026-08-10-provider-and-model-layer.md) | — |
| 2a | Permissions — rule model | **landed** — live enforcement completed · `8dff33f41` | [spec](specs/2026-08-11-permission-rule-model.md) | — |
| 2b | Permissions — OS sandbox | **landed** — Linux + macOS backends verified in CI · `b9a7bb337` | [spec](specs/2026-08-12-os-sandbox.md) | — |
| 3 | Context engineering | **landed** — eviction + deferred schemas verified against the replay corpus · `72a2fefe4` | [spec](specs/2026-08-13-context-engineering.md) | — |
| 4 | Tool surface | **landed** — all 7 tasks (4.1–4.7) done, budget fixed at 2,150/2,300 tokens · `faffaa79e` | [spec](specs/2026-08-13-tool-surface.md) | — |
| 5 | Delegation & multi-agent | **landed** — 7 of 7 tasks · `edb760ff4` | [spec](specs/2026-08-14-delegation-and-multi-agent.md) | — |
| 6 | Durable state & daemon | **landed** — 6 of 6 tasks · `baf5e5302` (full-suite audit recorded) | [spec](specs/2026-08-15-durable-state-and-daemon.md) | — |
| 7 | Evidence & verification | **landed** — 7 of 7 tasks · `c82584312` (clean Node 22 verification) | [spec](specs/2026-08-16-evidence-and-verification.md) | — |
| 8 | Observability & cost | **landed** — 7 of 7 tasks, exit criterion amended before implementation · `9c7c9e9aa` | [spec](specs/2026-08-15-observability-and-cost.md) | — |
| 9 | Release hardening | **landed** — 6 of 6 tasks · `a0be145d7` | [spec](specs/2026-08-16-release-hardening.md) | — |
| 10 | Complete the Apex Code product surface | **landed** — 7 of 7 tasks · `6b602044d` (required three-OS CI run 31940072123) | [spec](specs/2026-08-16-complete-apex-product-surface.md) | — |
| 11 | Remove unowned hosted-service defaults | **landed** — 5 of 5 tasks · `bfa746d0c` (required three-OS CI run 31945192886) | [spec](specs/2026-08-16-remove-unowned-hosted-service-defaults.md) | — |
| 12 | Production graduation and release integrity | **landed** — baseline 15 of 15 tasks at `eb6df850d`; standalone GitHub Release installer landed at `ac930a485` | [baseline spec](specs/2026-08-16-production-graduation-and-release-integrity.md) · [installer spec](specs/2026-08-25-standalone-release-installer.md) | — |

## Product-surface follow-ups

| Follow-up | State | Spec | Plan |
| --- | --- | --- | --- |
| LSP diagnostics | **landed** — LSP.1 through LSP.6, ADR 0020 accepted | [spec](specs/2026-08-18-lsp.md) | — |
| Sandbox skill projection | **landed** — SKILL.1 through SKILL.9 · `cac7e49f8` | [spec](specs/2026-08-20-sandbox-skill-projection.md) | — |
| Supervisor-mediated credential writes | **landed** — `4016794c3` | [spec](specs/2026-08-22-supervisor-mediated-credential-writes.md) | — |
| Terminal interaction polish | **landed** — `697746b94` | [spec](specs/2026-08-23-terminal-interaction-polish.md) | — |
| Sandbox delegation and escalation | **landed** — U1 through U7 · `6b628677a` | [spec](specs/2026-08-28-sandbox-delegation-and-escalation.md) | — |
| Composer dock surface | **landed** — filled, cursor-safe prompt dock · `2bd3008f1` | [spec](specs/2026-08-23-composer-dock-surface.md) | — |
| Prime-inspired gold TUI | **landed** — gold-neutral layout and permission-safe tray · `e576190a5` | [spec](specs/2026-08-23-prime-inspired-gold-tui.md) | — |
| Ember TUI surface | **landed** — ember palette, counted startup, brand mark · `215801bfb` | [spec](specs/2026-08-25-ember-tui-surface.md) | — |
| Native MCP support | **landed** — 13 of 13 tasks · `ed3b3a9c1` | [spec](specs/2026-08-28-native-mcp.md) | — |
| Git-backed session checkpoints | **landed** — 8 of 8 tasks · `075fac684` | [spec](specs/2026-08-28-git-checkpoints.md) | — |
| Dependency updates that can merge | **landed** — `262d673cb` | [spec](specs/2026-08-29-dependency-updates-that-can-merge.md) | — |
| Documented surfaces that do not exist | **landed** — 4 of 4 tasks · `d2cb6ea0f` | [spec](specs/2026-08-29-documented-surfaces-that-do-not-exist.md) | — |
| Release tags and the spec status gate | **landed** — pull request #63 | [spec](specs/2026-08-29-claims-the-repository-cannot-check.md) | — |
| Mid-run auto-compaction | **landed** — `61be67e27` | [spec](specs/2026-08-29-mid-run-auto-compaction.md) | — |
| Declarative hooks | **in progress** — HOOKS.1 through HOOKS.7 | [spec](specs/2026-08-31-declarative-hooks.md) | [plan](plans/2026-08-31-declarative-hooks.md) |

---

## Phase 0 — Fork foundation

**Objective.** A fork that builds, tests, releases, takes upstream changes, and can
**measure itself**. Nothing after this is trustworthy without the last item.

**Why first.** Two things here are load-bearing for the whole program: the upstream
merge discipline (or the fork rots) and the replay corpus (or every later phase's
exit criterion is unmeasurable).

**Scope.**
- **Task 0.1 — claim the name.** ✅ Done. Repo `apex-code`, binary `apex-code`, config
  dir `~/.apex-code/`, npm `apex-code` (unscoped, verified free), MIT license + Pi
  attribution, `CONTRIBUTING`. Task 0.5 claimed it with the first pre-alpha publication.
- **Task 0.2 — fork.** ✅ Done. Full-tree graft at `v0.84.0`, rehearsal merge to
  `v0.84.1`. Consumed packages frozen and CI-asserted (ADR 0001, amended).
- Build, typecheck, lint, test, and a release pipeline that produces an installable
  artifact from day one. A release path added in Phase 9 is a release path that has
  never been exercised.
- **Upstream merge rehearsal.** ✅ Done, and it disproved its own premise: at fork+0
  divergence the hunk count is 0 by construction, so ADR 0003's ceiling basis moved
  past Phase 2. Upstream churn is the honest Phase 0 metric.
- **Replay corpus + headless metrics harness.** A fixed set of recorded sessions
  (start from the real transcripts in `.omp`, `.prime`, `.atomic`) replayable
  offline, emitting deterministic metrics: context tokens at turn N, system-prompt
  token count, tool-call counts, wall time, cost. This is the instrument every later
  gate reads.
- Port the doc conventions: `docs/adr/`, `docs/specs/`, `docs/plans/`, `AGENTS.md`.

**Exit criterion.** CI green on three platforms. One upstream release merged with the
hunk count recorded. Replay corpus runs headless and produces identical metrics across
two consecutive runs on the same input.

**Progress against it** (verified, not asserted — see `docs/upstream-log.md`):

| Criterion | State |
| --- | --- |
| CI green on three platforms | **met as amended.** Run [`31454315906`](https://github.com/Fchery87/apex-code/actions/runs/31454315906) passed the frozen-package gate and concluded success. Ubuntu passed all required steps. macOS passed Build and Check, with one advisory inherited timing failure; Windows passed Build and Check, with its characterised advisory platform failures. The amended criterion is: *Linux green, macOS and Windows characterised.* |
| Published artifact installs and completes a provider turn | **met.** `apex-code@0.0.1-alpha.0` clean-installed from npm, reported the expected version, passed registry signature/attestation audit, and completed a configured Google turn. Release run [`31326901954`](https://github.com/Fchery87/apex-code/actions/runs/31326901954). |
| Upstream release merged, hunk count recorded | **met, and the criterion was wrong.** `v0.84.0` → `v0.84.1` merged: 1 conflicted hunk, 0 in forked paths. But at fork+0 divergence a hunk count is zero by construction and cannot found a ceiling. ADR 0003 was amended to move the ceiling basis past Phase 2; the honest Phase 0 metric is upstream churn — 57 files / ~2,000 lines per patch release. |
| Replay corpus deterministic across two runs | **met.** Eight scrubbed synthetic native-v3 sessions replay offline through the Agent loop. The stable metrics schema and lexically ordered corpus output are byte-identical across consecutive runs (Task 0.9). |

Two criteria above are recorded as *amended* rather than ticked. Phase 0 closed against
the amended wording, not the original — a criterion that turned out to be unmeasurable
was corrected on the record, never quietly marked done.

**Risks.** The corpus is the task most likely to be skipped as "not real work." It is
the highest-leverage item in the phase. Sessions also carry live API keys and repo
paths — the corpus needs a scrubbing step before anything is committed.

---

## Phase 1 — Provider & model layer

**Objective.** Provider- and model-agnostic in the operational sense, not just the
"can reach 35 endpoints" sense. `pi-ai` already delivers reach; this phase adds
everything above it.

**Scope.**
- **Credential pool** with failover — modeled on OMP's `auth_credentials` +
  `auth_credential_blocks` + `auth_credential_refresh_leases` + `identity_key`. A
  rate-limited or blocked key rotates rather than failing the turn.
- **Model roles** (`default` / `plan` / `tiny` / `designer`, extensible) — OMP's
  `modelRoles`. This, not a single `defaultModel`, is the right provider-agnostic
  answer to "which model for which job."
- **Fallback chains** per role, with the recovery semantics from c-code's
  `fallbackModel`.
- **Measured routing**: a `model_perf` table (`ttft_ms`, `gen_ms`, sample counts) so
  role→model resolution is driven by measurement, not guesswork.
- **Credentials out of plaintext config.** Both `.omp/agent/models.yml` and
  `.prime/agent/models.json` currently hold a live API key in cleartext. The fork
  reads keys from the credential store or env, never from a committed config file.

**Exit criterion.** A forced 429 on the primary credential rotates to a secondary and
the turn completes (test). Role routing resolves to distinct models per role from one
config. Per-turn recorded cost is within 5% of provider-reported cost across the
replay corpus. No API key appears in any file the config loader writes.

**Risks.** Cost tables drift constantly. Treat `cost` as data to refresh, and add a
staleness warning rather than silently reporting wrong numbers.

**Progress against it** (verified, not asserted):

| Criterion | State |
| --- | --- |
| Forced 429 on primary rotates to a secondary and the turn completes | **met.** `packages/coding-agent/test/model-runtime-failover.test.ts` exercises this through the real `ModelRuntime.streamSimple()` seam via a registered fake provider; the classified failure and rotation are also proven for role-level model fallback (`streamSimpleForRole()`), all-fail exhaustion (original failure preserved, not the last), non-retryable errors (no rotation), and an already-cancelled request (no attempt). |
| Role routing resolves distinct models per role from one config | **met.** `packages/coding-agent/test/model-roles.test.ts`: `default`/`plan`/`tiny`/`designer` plus a custom role name resolve to distinct models from one `models.json`; a legacy file with no `roles` key resolves to an empty role map, leaving existing initial-model selection untouched. |
| Per-turn recorded cost within 5% of provider-reported cost, replay corpus | **met.** `packages/coding-agent/test/replay-runner.test.ts` independently re-derives provider-reported cost from each fixture's raw JSONL (bypassing the replay pipeline) and reconciles it against replay-reported cost per corpus result, plus a nonzero-cost scratch case; zero network calls verified. Today's recorded-passthrough accounting reconciles exactly — the 5% tolerance is the stated contract for when that changes, not a loosened assertion. |
| No API key appears in any file the config loader writes | **met.** `packages/coding-agent/test/model-config.test.ts`: a legacy `models.json` with a literal key, a `$ENV` reference, and a `!command` reference all load unchanged; the loader never writes the file, never logs, and never copies a resolved secret into loader-generated output. |

Also delivered, beyond the letter of the exit criterion: a deterministic, non-secret
`CredentialPool` (rotation, cooldown/blocked exclusion, single-owner refresh leases —
`credential-pool.test.ts`), and a versioned, mode-0600 `UsagePerformanceStore`
recording one non-secret sample (provider/model/role/credential-identity/outcome/
ttft/generation/usage/cost) per request attempt, win or rotated-away
(`usage-performance-store.test.ts`).

Full verification: `npx tsgo --noEmit` clean; `npm --workspace packages/coding-agent
test` green except pre-existing failures unrelated to this phase (`external-editor`,
`radius`, `skills`, `startup-session-name`, `tools` grep-flag tests,
`6999-models-json-hot-reload`) — confirmed present against the pre-Phase-1 tree, not
introduced by it.

**Order changes.** Task 1.2 (credential-pool selection) was implemented and verified
before Task 1.1 (secrecy guard): it is a pure module with no dependency on the
config/secret-boundary work Task 1.1 establishes, so there was no ordering hazard.

---

## Phase 2 — Permissions & sandbox

**Objective.** The safety floor. Pi has none — `security.md` is explicit that project
trust is "only an input-loading guard." This is the largest single gap between Pi and
a harness you can run unattended.

**Why here.** The `ruleContent` contract must exist before the tools that interpret
it. Every tool added before this phase is a retrofit.

**Scope.**
- Rule model: `{source, ruleBehavior: allow|deny|ask, ruleValue: {toolName, ruleContent?}}`,
  with `ruleContent` interpreted **by the tool** (so `Bash(git commit:*)` stays a
  bash-local concern).
- Source precedence, explicit and test-covered: `policy > flag > local > project > user > cliArg > command > session`.
- Modes: `default`, `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk`.
- `PermissionUpdate` as a typed, persisted operation (`addRules` / `replaceRules` /
  `removeRules` / `setMode`) against explicit destinations.
- Interception at `beforeToolCall` — the seam Pi's `Agent` already exposes.
- **OS-level sandbox** underneath: filesystem read/write restriction, network host
  allowlist, and a violation store. The interactive escalation callback named here was
  deferred by ADR 0005 when it was accepted, and is not part of what 2b delivered. ADR-0005
  must state plainly what the boundary does and does not guarantee — Pi's own
  security doc is right that a half-sandbox misread as a real one is worse than none.

**Exit criterion.** A test asserts **every** registered tool passes through the
permission gate — no exceptions list. Precedence verified across all eight sources.
The sandbox blocks a write outside the workspace and a request to a non-allowlisted
host, and both surface as violations rather than silent failures.

**Risks.** Sandbox implementation is platform-divergent and is where this phase will
overrun. Ship the rule model first; it is independently valuable and unblocks Phase 4
on its own.

### Amendment (2026-08-11): split into 2a and 2b

The phase is **split on the record**, acting on its own Risks note rather than
discovering it mid-implementation. The exit criterion above is unchanged in substance
and is divided at its own seam:

| Sub-phase | Scope | Exit criterion |
| --- | --- | --- |
| **2a — rule model** | Rules, eight-source precedence, modes, `PermissionUpdate`, `beforeToolCall` interception, `ToolContract` backfill for the seven inherited tools. ADR 0004. | Every registered tool passes the gate, registry-derived with no exceptions list. Precedence verified across all eight sources. |
| **2b — OS sandbox** | Filesystem read/write restriction, network host allowlist, violation store. Interactive escalation is **deferred** by ADR 0005 and tracked in `docs/specs/2026-08-28-sandbox-delegation-and-escalation.md`. ADR 0005. | The sandbox blocks a write outside the workspace and a request to a non-allowlisted host, and both surface as violations rather than silent failures. |

**Phase 4 is gated on 2a only.** What Phase 4 needs is the `ruleContent` grammar its
fifteen tools declare against; it does not need OS enforcement to exist. Keeping the
two joined would let a platform-divergent sandbox block a phase that never depended
on it — the exact overrun this phase's own Risks note predicted.

2b is not descoped and not deprioritized. It remains a Phase 2 obligation, and the
safety floor is not complete until it lands; a rule model without enforcement
underneath constrains a cooperative model and nothing else. It is sequenced second
because it is the half that can slip.

**Phase 2a closure — completed 2026-08-12.** The permission gate is now constructed
for every `main.ts` runtime creation, including runtime replacement after session
switch/reload. The live gate receives a cwd-bound `FilePermissionRuleStore`, resolves
persisted and `--permission-mode` modes for every call, binds the interactive responder
only after the TUI is available, and fails closed in print, JSON, and RPC modes. A
headless session without `--permission-mode` fails before session creation (metadata
commands remain exempt).

The close-out also fixed the review findings that made a configured gate incomplete:

- nonblocking extension `tool_call` results and extension-mutated input now proceed to
  the gate; only `{ block: true }` remains an early return;
- policy rules cannot be overridden by `bypassPermissions`, while `plan` retains its
  mutating-operation safety floor;
- unreadable or malformed authorization sources fail closed, persisted modes are
  validated, and `--allowed-tools` supplies the documented low-precedence `cliArg`
  rule layer;
- bash treats redirections, expansion, glob, brace, tilde, and other unsupported shell
  grammar as unparseable, which resolves to `ask` rather than authorizing by prefix;
- foreign tools are marked `unclassified` in the registry and reported as an
  approval-required runtime diagnostic.

**Verification run for this completion:**

- `npx tsgo --noEmit` — passed.
- `npx biome check $(git diff --name-only)` — passed.
- `npm run build` — passed.
- `npm --prefix packages/coding-agent test -- test/permissions test/stdout-cleanliness.test.ts test/suite/agent-session-model-extension.test.ts test/agent-session-dynamic-tools.test.ts` — 12 files / 167 tests passed.
- `npm test` — scripts and `packages/agent` passed; the coding-agent full run remained
  red with 23 failures across 14 files plus one error. The failures were in the
  existing parallel/CPU-sensitive full-suite seams (including `agent-session-concurrent`,
  external editor/TUI rendering, and path-spawn tests); the changed permission and
  stdout tests passed in the targeted run above. This is not represented as a green
  full-suite verification.

**Phase 2b progress — both Linux and macOS backends land and verify, 2026-08-12 to
2026-08-13.** The Linux backend (Bubblewrap: filesystem read/write restriction, an
`--unshare-net` deny-all default, a supervisor-owned HTTP CONNECT allowlist proxy
bridged over a Unix domain socket, and a bounded violation store wired into the
production CLI) meets the Phase 2 exit criterion stated above — a write outside the
workspace and a request to a non-allowlisted host both fail closed and surface as
recorded violations, proven through the real CLI entry point with a live scripted
agent turn, not just the backend in isolation. Task 2b.6 (in the since-deleted
`docs/plans/2026-08-12-os-sandbox.md`) obtained this phase's first genuinely clean
full `npm test` run — not killed, truncated, or scoped down by the environment —
confirming no regression beyond the same 4 pre-existing, sandboxing-unrelated files
already characterized in 2b.4c.

**macOS support (2b.5) has since landed too** — Seatbelt (`sandbox-exec`), verified
238 test files / 2112 tests / 0 failures on real `macos-latest` CI (macOS 26.5.2);
this development environment is Linux-only and has no macOS host, so every bit of
that verification happened on GitHub Actions across six real CI iterations, not
locally. Five real, hardware-only bugs surfaced and were fixed along the way — see
the plan's 2b.5 record for the full account. macOS's network guarantee is real but
categorically weaker than Linux's (no private per-process loopback; see ADR 0005's
amendments), and Apple Events/Launch Services denial plus code-signing behavior for
a distributed binary remain unaddressed. Fixing `npm run check` (a pre-existing,
unrelated lint failure that had silently blocked `npm test` from running in CI on
*any* platform for a while) also surfaced that Linux's own sandbox suite has never
actually run in CI either — `bubblewrap` isn't installed on `ubuntu-latest`, and
installing it hits a separate, unrelated network-namespace CI restriction.

**That follow-up (task 2b.7) is now closed too, and Phase 2b is landed.** Root
cause, confirmed on real `ubuntu-latest` CI: Ubuntu 24.04 runner images restrict
unprivileged user-namespace creation via AppArmor by default, which blocks the
`unshare(CLONE_NEWUSER|CLONE_NEWNET)` `bwrap --unshare-net` depends on — not a bug
in this repo. Fix: `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
before `bwrap` runs, scoped to the ephemeral runner. `ci.yml` now installs
`bubblewrap` and sets this; the required `ubuntu-latest` CI job runs the real
Linux sandbox suite end to end (240 files / 2114 tests passed / 53 skipped / 0
failed).

Closure verification for the whole of Phase 2b (both backends, current tree):
`npx tsgo --noEmit` and `npm run build` both clean. A full unscoped `npm test`
under normal parallelism showed 6 failed files / 8 failed tests — 4 of those files
(`external-editor`, `radius`, `skills`, `6999-models-json-hot-reload`) are the
same pre-existing, sandboxing-unrelated failures characterized in 2b.4c; the other
two (`agent-session-concurrent`, `sandbox/live-agent-boundary`) are CPU-contention
timeouts under full-suite parallel load, not regressions — confirmed by rerunning
the full suite with `--no-file-parallelism`, which came back with only the same 4
pre-existing failures (237 passed / 6 skipped of 247 files; 2123 tests passed / 53
skipped), and by running `test/sandbox` alone, which was fully clean (10 files /
29 passed / 4 skipped / 0 failed), with the two heavy subprocess-spawning tests
each legitimately taking 18-19s.

Per `AGENTS.md`'s plan lifecycle convention, `docs/plans/2026-08-12-os-sandbox.md`
is deleted now that Phase 2b is landed (recoverable via
`git show <commit>:docs/plans/2026-08-12-os-sandbox.md`); its durable content
lives in this section and in the spec/ADR amendments. Windows remains unsupported
per ADR 0005. Apple Events/Launch Services denial and code-signing behavior for a
distributed macOS binary remain open, out of Phase 2b's stated scope.

**Follow-up (2026-08-20 — the boundary silently disabled the skills subsystem.)** Phase
2b's whole-CLI launch hides host-home and repoints `HOME` and the agent directory into
the workspace. The inherited skills subsystem computes its user-scope discovery roots
from exactly those two values, so every sandboxed session loads **zero** user skills,
with no diagnostic and with `packages/coding-agent/docs/skills.md` still documenting the
feature as working. Measured against a real 115-skill library: 115 skills on the host,
0 under the child's computed environment. This is not a Phase 2b regression in the
boundary — the boundary did what ADR 0005 says — it is a subsystem that was never
adapted to it, and no Phase since had scope that would pick it up. Repairing it also
completes a Phase 3 obligation: the discovered catalog costs 6,742 prefix tokens against
128 tokens of headroom, so the projection moves to name-only behind a token budget with
descriptions resolved through a tool ([ADR 0021](adr/0021-skill-catalog-deferral.md)).
Specced and planned as a Phase 2b / Phase 3 follow-up rather than a new phase:
[spec](specs/2026-08-20-sandbox-skill-projection.md). Phase 2b's **landed** state is
unchanged and is not reopened by this.

**That follow-up (SKILL.1-9) is now landed and the spec is marked `Complete`.** Nine
commits, each independently green through the full pre-commit `check` pipeline:
`02ebeb4c3` (failing repro) · `2c5079f5e` (SKILL.2, mount and resolve) · `c5a2ea5dc`
(SKILL.3, child discovery, plus revising SKILL.2's wire format to two named
environment variables once the "pi" vs "agents" discovery-mode split made one
delimited list unable to say which root a lone survivor was) · `b8e741514` (SKILL.4,
host-home escape refusal, plus real enforced-`bwrap` proof) · `cac7e49f8` (SKILL.5,
command-token slugging so an invalid raw name is still invocable) · `768532e93`
(SKILL.6, the budget-bounded name-only catalog, ADR 0021) · `70030a52b` (SKILL.7, the
`skill_search` tool) · `f2dd9a385` (SKILL.8, the real-measurement budget guard) · a
final closing commit for SKILL.9 (docs, this entry, plan deletion). Measured, not
assumed: the no-skills static prefix floor moved from 2,372 to 2,393 tokens
(`skill_search`'s own always-on cost), a populated skill library measures 2,987
tokens regardless of size (200 and separately 2,000 synthetic skills, identical --
direct proof the catalog is bounded by construction), and
`ENFORCED_PRODUCTION_PREFIX_BUDGET` is raised to 3,150, the same ~5.5% proportional
margin LSP.7 used. Full verification: `npm run build`, `npm run check`, and both
workspace test suites clean (`agent`: 20 files / 398 passed / 1 skipped / 0 failed;
`coding-agent`: 305 files / 2,579 passed / 57 skipped / 0 failed, confirmed on two
independent full runs after one file's flake under parallel load was proven
non-reproducible in isolation and ruled unrelated). **Not done:** the required
three-OS CI run this repo's closure practice otherwise calls for was not executed as
part of landing this locally-verified work; the macOS `sandbox-exec` path is written,
gated `describe.skipIf`, and unexercised here. `docs/plans/2026-08-20-sandbox-skill-projection.md`
is deleted now that this follow-up is landed (recoverable via
`git show <commit>:docs/plans/2026-08-20-sandbox-skill-projection.md`); its durable
content lives in this entry and in the spec's own closure amendment.

**Post-PR-#33 review follow-ups landed, 2026-08-22.** Three review leftovers from the
`web_search` merge, worked as a plan rather than a phase:

- **Supervisor-mediated credential writes** (`4016794c3`), implementing
  [spec](specs/2026-08-22-supervisor-mediated-credential-writes.md): `/login` works inside
  a sandboxed session through a supervisor-owned unix socket that refuses `!command` and
  `$VAR` values, audits every accepted write and refusal, and leaves every read path and
  the read-only mount untouched. ADR 0015 carries the dated amendment. Linux is verified
  by a live sandboxed CLI turn; macOS is verified at the Seatbelt-profile level, with the
  live gate (now platform-general) awaiting its first CI run on push.
- **Supervisor launch cost** (`93e0138ba`): `settings-manager` no longer statically
  imports `proper-lockfile` or `undici` on the pre-child path. Measured A/B with
  `scripts/measure-supervisor-imports.mjs --dist` on one loaded machine: the module fell
  1968.8 ms → 576.8 ms and the whole supervisor import path 2728.9 ms → 812.1 ms.
- **Review small items** (`e798d83a5`): the suite harness now scrubs every provider
  credential variable `getEnvApiKey` reads (closing the `7209` breadth gap for
  `HF_TOKEN`, `COPILOT_GITHUB_TOKEN`, the Bedrock container vars, and the Vertex ADC
  trio, with a pinning test), and `web_search` snippets trim to a word boundary. The
  `.gitignore` carve-out was verified complete as landed in `33c6f99cd` — nothing to
  change.

Full-suite status, stated as run: two root `npm test` runs — one under load ~23 (20
timeout failures across 8 CLI-spawning files, all passing in isolation), one calm (a
single `bash`-tool output-persistence flake, passing in isolation) — with every
changed-seam suite green and none of the flakes intersecting the changed files; the same
load-flake signature this machine produced before these changes.
`docs/plans/2026-08-22-pr33-followups.md` is deleted now that the work is landed
(recoverable via `git show <commit>:docs/plans/2026-08-22-pr33-followups.md`); Phase 2b's
**landed** state is unchanged.

### Follow-up (2026-08-29): dependency updates that can merge — landed

Every open Dependabot pull request was red, and had been since it was opened. Nine of nine,
on all three operating systems, failing before a single test ran. The blocked set included
`undici` and `hosted-git-info`, in a repository whose Phase 12 release gates require a
production dependency vulnerability audit.

`.github/dependabot.yml` declared three npm ecosystems: `/`, `/packages/agent`, and
`/packages/coding-agent`. This is an npm workspaces monorepo with one authoritative
`package-lock.json` and CI installs with `npm ci` from the root. Dependabot treats a
per-package directory as an independent project, so it edited that `package.json`, left the
root lockfile alone, and every such pull request died at install with
`Missing: <pkg> from lock file`. Reproduced on a clean clone; the error is byte-identical.
The same pull requests also rewrote `packages/coding-agent/npm-shrinkwrap.json`, which is
generated from the root lockfile rather than authored.

`scripts/apex/dependabot-config.test.mjs` asserted those three directories exactly, so the
suite guaranteed the configuration stayed wrong and handed anyone who corrected it a red
test. That is the part worth remembering: a test can encode a belief the evidence disproves,
and then defend it.

The configuration's comment separately claimed directory scoping kept Dependabot out of
frozen packages. Pull request #11 disproved it — a root-scoped `chalk` bump rewrote
`packages/tui/package.json`, because npm workspaces resolves a shared dependency across the
whole tree — and failed the byte-identity gate. The gate was working; the comment was not
true. It now describes what happens instead of asserting it cannot.

One npm ecosystem at `/` now, the test asserts that shape and records why a per-package entry
cannot work, and `CONTRIBUTING.md` carries the one manual step that remains: a bump reaching
the published tree leaves the derived shrinkwrap stale and `npm run shrinkwrap:coding-agent`
fixes it. A mergeable bump changes exactly three files, verified end to end on a clean clone.

Two things are deliberately not closed. Automating the shrinkwrap regeneration needs a
workflow that commits to a bot branch, which is a real permissions decision and gets its own
spec. And a bump that touches a frozen manifest still cannot merge, by design; that is now
the only remaining Dependabot failure category rather than one of three.

**Correction (2026-08-29).** This section first said "the nine superseded pull requests were
closed". Both halves were wrong. Nine was the number of recent *failing CI runs* sampled, not
open pull requests, and nothing was closed by hand. The real queue at the time was
twenty-nine: seventeen from the two removed per-package ecosystems, which Dependabot closes
itself once those ecosystems are gone; nine from the root ecosystem, which is kept, so they
stay valid and stay red until their derived shrinkwrap is regenerated on the branch; and three
`github-actions` pull requests this change does not affect. Bulk-closing the queue by hand
would have closed the nine legitimate ones too.

### Follow-up (2026-08-29): documented surfaces that do not exist — landed

Three things this repository documented were not in it, found by auditing its own claims
rather than by a bug report.

`README.md:197` taught `/help` as the first entry under "Useful first-session commands" and
no such command was registered, so a new user's first action failed. `/help` now renders
every command the session can run. The command assembly that fed autocomplete is extracted
so both surfaces read one list; two lists that must agree, built in two places, is how this
rots. The regression test parses README's documented block and checks every entry against
the registry, because fixing the one name would have left the next one to be found by a
user.

`buildToolContractSnapshot()` was named in ten documents — including `AGENTS.md`, which is
read before an agent's first edit — and defined in none. An agent told "never re-derive a
tool's classification, one projection serves every surface" could not follow the
instruction, and `docs/specs/2026-08-18-lsp.md:114` already carried the workaround in
writing. `core/tools/contract-snapshot.ts` implements it with the two consumers that exist:
the startup unclassified diagnostic and the ADR 0010 drift test. It describes and never
enforces, and `context/pipeline.ts` and `context/eviction.ts` keep consuming
`contractLookup` directly, which ADR 0010 permits because they enforce. `getAllTools`
derived the same `unclassified` fact independently; that predicate is now shared, since two
derivations of one fact in two files is the drift the ADR names even while they agree.

`src/server/create-harness.ts` was reachable by nothing: absent from `src/index.ts`, absent
from the package `exports` map, imported only by its own test. It is the "two session
stores" ambiguity the 2026-08-28 review recorded and left unresolved, and the trace
resolves to the shipped CLI driving `core/session-manager.ts` while this path drove nothing.
Deleted, with `AgentHarness` in `apex-code-agent-core` untouched. Recoverable via
`git show <commit>:packages/coding-agent/src/server/create-harness.ts`.

Landed 2026-08-29 across four commits (`d32061c9c`, `3046ec6a6`, `0cc7d2d8b`, `d2cb6ea0f`).
One thing is recorded rather than closed: `/tools` and `/doctor`, the two surfaces ADR 0010
names as consumers, remain unbuilt on purpose. Inventing commands nobody asked for to
justify the projection would invert the reason for building it.

**Correction (2026-08-29).** This section originally recorded ADR 0010's invariant 5 as
owed, on the reasoning that a registry-wide `matches(ruleForCall(p), p)` needs valid sample
`params` per tool and that a hand-written table would rot. Both halves were wrong.
`test/permissions/contract.test.ts:107` has asserted invariant 5 across the whole registry
since before the projection existed, and the `REPRESENTATIVE_PARAMS` table it uses is keyed
by tool name precisely so a newly added tool fails loudly instead of being skipped -- which
answers the rotting objection by construction. That file also owns invariants 1 and 4.

The two registry-wide cases added alongside the projection duplicated invariant 1 and have
been removed; `test/tools/contract-snapshot.test.ts` covers the projection itself and points
at `contract.test.ts` for the registry invariants. Recorded here rather than quietly edited,
because the claim shipped in a merged pull request and the mistake is the same one this
follow-up existed to fix: a document asserting something about the code that was not true.

The last commit is a self-inflicted one worth naming. Extracting the command assembly broke
two existing autocomplete tests that built a plain-object `this`, and the targeted subsets
run before committing did not include the tests for the file that changed. The full suite
caught it.

### Follow-up (2026-08-29): claims the repository cannot check — landed

Three of this repository's own claims were false. Each had a mechanism that should have
caught it, and in each case the mechanism either did not exist or asserted the wrong thing.

`npm install apex-code` served `0.0.1-alpha.0`, a version this project had itself
deprecated with the message "Stale prerelease. Use apex-code@next (0.0.1-alpha.2) or
later." Both publish steps in `release.yml` carried `--tag next` unconditionally, so
nothing ever moved `latest` off the first publication. `scripts/release-workflow.test.mjs`
asserted that literal command string twice. That is the second test in one week found
defending the configuration it was meant to guard, after
`scripts/apex/dependabot-config.test.mjs`, which is enough to call it a pattern rather
than an accident. The publish job now derives the tag from the validated version, a
prerelease going to `next` and a stable version to `latest`, under ADR 0026.

Sixteen tests in `packages/coding-agent` had not run in CI since 2026-08-09.
`npm test` carried `--exclude test/config.test.ts`, added by `93d5074da` whose subject is
"test only Apex-owned packages" — and `packages/coding-agent` is one. The file passes, 16
of 16. `scripts/package-test-config.test.mjs` now rejects any exclusion rather than that
one, because naming the file found would leave the next one to be found the same way.

Sixteen of twenty specs reported a lifecycle status their own roadmap contradicted, Phase
3's spec reading `Draft` for a landed phase and the native MCP spec reading the same. The
cause was a missing value: `TEMPLATE.md` offered `Draft`, `Active`, and `Superseded`, none
meaning the work shipped, so three replacements were invented independently. `Landed` is
now defined, every spec carries exactly one standalone `**Status:**` line, and
`validate-docs-lifecycle.mjs` rejects disagreement with the roadmap row in **either**
direction. The reverse check is the one that matters: a spec understating landed work
wastes a reader's time, while a spec claiming `Landed` for work in progress is what makes
a reader skip it.

Extending that gate found two things the audit had not. Every spec must now be reachable
from a roadmap table row, because a row is the only place a state is declared, and six
specs were reachable only from prose or from nothing: LSP, sandbox skill projection,
supervisor-mediated credential writes, terminal interaction polish, sandbox delegation and
escalation, and the ember TUI surface. All six now have rows. And **seven written ADRs
were missing from this document's own allocation table** — 0019 through 0024, plus 0026.
The roadmap states that numbers are allocated when an ADR is written, which makes that
table the ledger answering "which number is free", and it had been wrong since 0019. The
validator now rejects a written ADR with no row. It deliberately accepts a row with no
ADR, because this document defines such a row as a reservation.

**Not closed.** The live registry is unrepaired. The workflow governs future publications
only, so `latest` still resolves to the deprecated alpha until an authenticated maintainer
runs the two `npm dist-tag add` commands in `docs/release-governance-checklist.md`.
`npm view apex-code dist-tags --json` is the one-line check that says whether it happened.

### Follow-up (2026-08-28): git-backed session checkpoints — landed

Session rewind was half built. `/tree` and `/fork` navigate the conversation tree, and
nothing put the working tree back, so accepting a fork left the files from a later turn
attached to an earlier one. `examples/extensions/git-checkpoint.ts` demonstrated the missing
half and could not deliver it: checkpoints lived in a process-local map, capture used
`git stash create` (a commit reachable from no ref, which `git gc` reaps), untracked files
were never captured, and restore used `git stash apply`, which merges rather than restores.

The registry was the defect, not the four symptoms. Checkpoints are git refs under
`refs/apex-code/checkpoints/<sessionId>/<entryId>`, so a commit stays reachable and a restart
resolves it with no Apex-side persistence. Capture and restore each run through a private
`GIT_INDEX_FILE`, leaving the user's index, worktree, `HEAD`, branch, and stash untouched,
and `commit-tree`/`update-ref` are plumbing so no hook fires.

No `git` tool was added and `ToolName` is unchanged, so the static prompt prefix is
unaffected. ADR 0010 requires four contract axes per tool and ADR 0011 prices one at roughly
77 tokens; `bash` already runs git with the identity U1 projects into the sandbox, so a tool
would have cost the prefix to duplicate what exists.
[`specs/2026-08-28-git-checkpoints.md`](specs/2026-08-28-git-checkpoints.md) specifies the
design and `docs/plans/2026-08-28-git-checkpoints.md` tracked the eight tasks, and is deleted
now the work is landed (recoverable via
`git show <commit>:docs/plans/2026-08-28-git-checkpoints.md`).

Two defects reached review rather than the author. `windows-latest` caught a line-ending
conversion invisible on Linux and macOS: `core.autocrlf` is `true` by default on Windows, so
a restore silently rewrote line endings across the worktree. Every invocation now pins
`core.autocrlf=false`, while `.gitattributes` is deliberately honoured because that is the
repository's policy rather than the machine's. The automated review then caught three more,
two of which contradicted comments the branch had already written: capture ran detached and
raced the turn it was meant to precede, `nextOrdinal` read the tail of two concatenated
sorted lists instead of taking a maximum, and a failed pre-restore pin did not stop the
restore. The three-OS matrix and an independent reviewer each earned their place here.

Landed 2026-08-28 across six commits (`17edae3c6`, `aef71d3a9`, `fe81da383`, `71bb4cdc2`,
`ca9bae79f`, `075fac684`). One gap is recorded rather than closed: the `turn_start` call site
has no test, because asserting it needs a driven turn against a live model.

### Follow-up (2026-08-28): native MCP support — landed

Apex Code had no MCP support. The only traces were a comment at `core/tools/contract.ts`
naming MCP servers as the example of a tool that cannot be classified, and a status string
offering "Resources, extensions, and MCP adapters" from a command that manages package
resources and never could configure a server.

Adoption was considered and rejected on one ground. A tool registered from outside the repo
cannot supply a `contract`, so it resolves `UNCLASSIFIED`: every capability, `ask` by
default, and matching by exact serialized arguments. Under that fallback a second call with
different arguments prompts again and no result is ever evictable, which is precisely what
ADR 0010 exists to prevent. `docs/research/2026-08-28-pi-extension-references-mcp-and-questions.md`
records the comparison, including that `pi-mcp-adapter` is 25,627 lines of non-test source
of which 8,444 was deliberately not built here.
[`specs/2026-08-28-native-mcp.md`](specs/2026-08-28-native-mcp.md) specifies the design and
`docs/plans/2026-08-28-native-mcp.md` tracked the thirteen tasks, and is deleted now the
work is landed (recoverable via `git show <commit>:docs/plans/2026-08-28-native-mcp.md`).

All thirteen landed on 2026-08-28 across four commits (`16e28d2db`, `5100c7a6c`,
`482c7df1e`, `ed3b3a9c1`). One `mcp` proxy tool replaces per-tool registration, metadata
caches to disk so `search` and `describe` answer with no server running, and servers connect
on the first call that needs one and disconnect when idle. ADR 0025 settles the rule grammar
before the tool shipped, because a rule lands in users' saved settings and can be extended
later but never re-spelled.

Two decisions were corrected by measurement rather than argument. Transport is inferred from
`command` versus `url`, never declared, because no MCP host writes a `transport` field and a
parser requiring one would reject every config file users already have. And capabilities
cannot be per-server: `contract.capabilities` feeds the delegation ceiling (`sdk.ts:467`) and
mode resolution (`gate.ts:66`), both per-tool and static, so one proxy tool carries the union
and the per-server distinction lives in the grammar instead.

Budget, stated as measured: the production static prefix is **2,891 tokens with no MCP
configured and 3,076 with two servers and forty cached tools**, a delta of 185 against the
enforced 3,700. Registering those forty tools directly at the 150-300 tokens each the spec
cites would have cost 6,000 or more. A session with no `.mcp.json` builds no runtime and its
prefix is byte-identical to before.

Full-suite status, stated as run: `npm run check` passed end to end, and `npm test` reported
**350 test files passed and 6 skipped, 3,020 tests passed and 58 skipped**, exit 0. Separately,
an end-to-end script drove `@modelcontextprotocol/server-everything` over real stdio and passed
14 of 14 checks, including that a second runtime built with a connector that throws still answers
`search` and `describe` from disk, and that the saved rule `Mcp(everything:echo)` authorizes a
differently-argued second call.

### Follow-up (2026-08-28): sandbox delegation and escalation — landed

2b delivered containment. It did not deliver the delegation half, and ADR 0005's own
deferral of interactive escalation named a prerequisite — supervisor/child IPC carrying a
concrete blocked-host request — that `core/sandbox/rpc/` satisfied on 2026-08-22, ten days
after the ADR was accepted.
[`specs/2026-08-28-sandbox-delegation-and-escalation.md`](specs/2026-08-28-sandbox-delegation-and-escalation.md)
specifies the seven units that close it, and
`docs/plans/2026-08-28-sandbox-delegation-and-escalation.md` tracked them, and is deleted now the work is landed
(recoverable via `git show <commit>:docs/plans/2026-08-28-sandbox-delegation-and-escalation.md`).
This does not change Phase 2b's **landed** state; escalation was never part of what 2b
shipped.

All seven units landed on 2026-08-28. A session now authors commits under the host
identity, asks before reaching an unlisted host, pushes with a host-owned credential that
never enters the workspace, and can run one approved command in a second child without its
own boundary widening. `--add-dir`, `--sandbox danger-full-access`, and
`--permission-profile` are the deliberate widenings, none reachable from project settings.
Three ADRs record the decisions: 0023 (escalation authority is the supervisor's, because
the RPC channel has no peer authentication), 0024 (an approved command runs in a second
child rather than widening the first), and amendments to 0005 and 0015.

Full-suite status, stated as run: `test:scripts` 21 passed; `packages/agent` 419 passed;
`packages/coding-agent` run in five filtered passes covering every directory and every
root-level file, 3060 tests passed with 58 skipped and 0 failed, each pass exiting 0. The
package was split because a single ~22-minute invocation was twice terminated by the
harness mid-run, not by a failure. `npm run check` passes end to end.

---

## Phase 3 — Context engineering

**Objective.** Make a large tool surface and long sessions affordable, before either
exists.

**Scope.**
- **Tool-result eviction** ("microcompact"): evict old tool results in place, leaving a
  marker. Reclaims most of the context cost with no summarization call and no loss of
  conversational structure. The single highest-value context technique in the systems
  reviewed. The eviction predicate is each tool's own `ContextSpec.resultRecoverable`
  (ADR 0010), **not** a name whitelist — this scope previously read "(read, shell,
  grep, glob, …)", but `bash` declares `resultRecoverable: false` because a shell
  command is frequently not reproducible, and the contract wins over the list.
- **Deferred tool schemas**: tools announce by name; full JSONSchema loads on demand
  via a search tool. MCP tools deferred by default with an always-load override.
- Keep Pi's compaction and **branch summarization** — the latter falls out of the
  tree-structured session format and c-code has no equivalent.
- Add reactive compaction on `prompt_too_long`, distinct from threshold-based
  auto-compaction.

**Exit criterion.** `long-tool-heavy.jsonl`'s own turn-20 down **≥80%** from its
15,272-token baseline — **met: 1,769 tokens, an 88.4% drop**, verified against the
theoretical eviction floor (budget 0 produces the identical 1,769, confirming this
isn't under-tuned). System-prompt tokens unchanged at **707** (and **960** on the
tool-heavy fixture) — no tool currently declares `deferSchema: true`, a deliberate
choice, see the second correction below. **No regression in task completion**:
`turnsCompleted` and response/tool-result equality hold unchanged across all nine
corpus fixtures. That last clause is the one that matters most — it is what stops
eviction from silently corrupting a replayed session.

**Correction (2026-08-13, first).** This criterion previously cited a "Phase 0
baseline of 1,563 tokens (1,745 / 1,380)." Those figures do not reproduce —
`replayCorpus()` measures 1,117 and 752 — and they contradicted ground rule 3 above,
which had the real numbers all along. The error made the gate vacuous: ≥40% off 1,563
is ≤938, and the corpus already sat at 935 before any work. See
`docs/specs/2026-08-13-context-engineering.md`.

**Correction (2026-08-13, second — the median criterion is retired.)** The revised
criterion above replaced a median-based one (`≤670`, down ≥40% from 1,117 across the
three turn-20-capable fixtures). That was found unreachable only after fixing a prior
gap: `replay()` built a bare `Agent` and never installed the context pipeline at all
(`262599f6c`), so every earlier measurement against this criterion was measuring
nothing. Once fixed and measured for real, the ≤670 number is not just difficult — it
is
**mathematically unreachable under the decisions already made**, proven by measurement
rather than argued: `compacted-session.jsonl` (752) and `long-multi-turn.jsonl` (1,117)
both carry zero tool calls, so eviction has nothing to act on in either, and no real
tool declares `deferSchema: true` (deferring one of the four always-on default tools —
the only ones `compacted-session.jsonl` exercises — was considered and explicitly
declined, since it fights deferred-schema's actual motivation of rarely-used tools, not
defaults). That leaves both fixtures fixed. `long-tool-heavy.jsonl`'s own eviction
floor — measured at budget 0, i.e. evicting every eligible result unconditionally — is
1,769, which is *still above* `long-multi-turn.jsonl`'s fixed 1,117. Since the median of
three values is bounded by whichever two are closest together, and one of the two fixed
values (1,117) is *always* less than the third value's own best case, the median of
`{752, 1,117, long-tool-heavy}` is invariant at **1,117** for any eviction quality
whatsoever — not approximately, exactly, provably. Re-recording the fixtures to change
this was already ruled out as a phase non-goal. The standalone `long-tool-heavy.jsonl`
assertion above is the real, sound signal; the median added no information a
zero-tool-call fixture pair couldn't already predict.

**Risks.** Eviction interacts with prompt caching: evicting a prefix invalidates the
cache and can cost more than it saves. Until 2026-08-13 this was unmeasurable — every
corpus fixture recorded `cacheRead`/`cacheWrite` of 0 — so `long-tool-heavy.jsonl` was
added carrying real cache usage (`cacheHitRate` 0.8569). A second, deeper gap surfaced
once eviction was actually wired into the replay harness: `cacheHitRate` is computed
from each fixture's recorded assistant-message usage, fixed at authoring time, and
verified to stay byte-identical (0.8569384835479256) whether eviction is on or off —
the offline harness replays pre-recorded responses rather than simulating a live
cache, so it cannot detect this risk at all, not even in principle. Prefix-oldest
eviction's cache safety rests on the structural argument in
`docs/architecture/contracts.md` § 2 alone; real validation is a stated follow-up for
a later phase, not something Phase 3's corpus can close.

**Closure.** All six plan tasks landed (`72a2fefe4`). Eviction and deferred-schema
resolution are wired into `AgentSession` in the settled order and, after fixing a real
gap where `replay()` bypassed that wiring entirely, into the replay gate too — measured
for real: `long-tool-heavy.jsonl` turn-20 drops 88.4% (15,272 → 1,769), past the 80%
goal. The median-based exit criterion was retired as mathematically unreachable (proof
above) and replaced with that standalone assertion. Reactive compaction on provider
overflow turned out to already exist, inherited pre-fork; the cache pre/post comparison
turned out to be structurally unmeasurable offline — both honestly recorded rather than
forced. `npx tsgo --noEmit` clean; a full `npm test --no-file-parallelism` from
`packages/coding-agent` showed 7 failed files / 240 passed / 6 skipped (2142 passed /
53 skipped tests) — 4 are the same pre-existing, unrelated failures characterized in
2b.4c (`external-editor`, `radius`, `skills`, `6999-models-json-hot-reload`); a 5th,
`agent-session-compaction.test.ts`'s "throws when compacting without configured auth",
was newly found but confirmed pre-existing by reproducing it against `c21f5b878` (the
commit immediately before this phase's replay-gate fix) in an isolated worktree — it
fails identically there, so it predates and is unrelated to this phase's work. Per
`AGENTS.md`'s plan lifecycle convention, `docs/plans/2026-08-13-context-engineering.md`
is deleted now that Phase 3 is landed (recoverable via
`git show <commit>:docs/plans/2026-08-13-context-engineering.md`); its durable content
lives in this section, the spec, and `docs/architecture/contracts.md` § 2.

---

## Phase 4 — Tool surface

**Objective.** Close the gap between Pi's seven core tools and a harness that can
actually do the work.

**Scope**, in dependency order: delegation entry points (Phase 5 builds them out),
`TodoWrite`, web search + fetch, plan mode, structured user questions, worktree
isolation, LSP. Each tool ships with its permission rules, its `ruleContent` grammar,
and tests — a tool without a rule grammar is not done.

**Exit criterion.** Every tool has permission rules and tests. Total system-prompt
token count stays under a measured budget — the deferred-schema mechanism is what makes
this possible, and this gate is what proves it worked.

**Correction (2026-08-13 — the "ceiling established in Phase 3" is restated as a
measured budget.)** The original wording required the token count to stay under Phase
3's ceiling. Phase 3 established 1,217 tokens for the production static prefix (28
prompt + 1,189 tool schemas, measured with the replay harness's `ceil(length / 4)`
formula), and 707 for the corpus, which measures only four tools. Holding either
number while adding roughly seven tools is arithmetically impossible: an announced,
schema-deferred tool still costs ~77 tokens for its name and description, so the new
tools alone add roughly +540 before any schema. Reaching 1,217 would require deferring
`read`/`bash`/`edit`/`write` as well, which is excluded by a standing decision. The
gate is therefore a budget fixed by measurement in the phase's first task, proven
against the naive no-deferral projection of roughly 2,400 — the deferred-schema
mechanism has to absorb the majority of the added schema cost, and the gap between the
enforced number and 2,400 is what evidences that. Recorded in full in
[the Phase 4 spec](specs/2026-08-13-tool-surface.md); the corpus's `systemPromptTokens:
707` is left untouched, because `productionPromptAndSchemas` selects only the four
default tools plus fixture-recorded ones and so cannot observe this phase at all.

**Blocking prerequisite.** Phase 3 wired the deferred-schema *announce* side into every
request but left the *load* side unwired — `loadDeferredSchema` has no production
caller. Until an on-demand schema-load path exists, `deferSchema: true` makes a tool
unusable rather than cheap, so it is the phase's first task and blocks every tool after
it.

**Correction (2026-08-13, second — the budget is fixed by measurement, closing the
estimate above.)** Task 4.7 measured the complete 14-tool registry once every Phase 4
tool (`todo_write`, `web_search`, `web_fetch`, `ask_user`, `plan_present`, `delegate`)
had landed: the naive no-deferral projection is **2,706 tokens**, not the ~2,400
estimated before the tools existed to measure. The enforced budget is fixed at
**2,300 tokens**, against an actual measured prefix of **2,150 tokens** with this
phase's real deferral choices in effect — every tool eligible for deferral
(`grep`/`find`/`ls`, in addition to the five tools that shipped already declaring it)
actually defers; only `read`/`bash`/`edit`/`write` (called on nearly every task) and
`plan_present` (called on nearly every plan-mode turn) do not, and `tool_schema`
cannot defer itself. That is a 556-token, ~21% reduction from the naive projection —
real and measured, not the majority of total prompt growth since Phase 3 (the four
excluded default tools are most of that growth and were never eligible to shrink).
Enforced in `test/context/static-prefix.test.ts`; full record in
[the Phase 4 spec](specs/2026-08-13-tool-surface.md)'s verified measurement record.

**Follow-up (2026-08-18 — LSP, the one scope item that did not land with the phase.)**
This phase's scope line ends "worktree isolation, LSP," and the Phase 4 spec deferred LSP
to its own document as a subsystem rather than a tool, naming the filename and the trigger
condition ("when the tools below are landed"). The tools landed at `faffaa79e`; the LSP
spec did not follow, and because Phases 5–12 are all closed there is no later phase whose
scope would pick it up. It is now specced and planned as a Phase 4 follow-up rather than a
new phase: [spec](specs/2026-08-18-lsp.md). Phase 4's
own **landed** state is unchanged and is not reopened by this — the phase met its stated
exit criterion, and this records an item that was scoped to it, deferred with a reason,
and left without an owner.

**Follow-up (2026-08-19 — the LSP follow-up landed, minus one severable task.)** Tasks
LSP.1–5 and LSP.7 (registry/client/pool, settings and fail-fast startup, sandbox spawn
inheritance and egress, diagnostics collector wired to `edit`/`write`, the `lsp` tool,
and closure verification) are done. LSP.6 (a `"diagnostic"` evidence-kind extension,
gated on an ADR that was never written) is deferred, not dropped — the plan always
treated it as severable from the rest. **Superseded (2026-08-29):** it is no longer
deferred. ADR 0020 was accepted on 2026-08-20 and LSP.6 landed with it, as
`specs/2026-08-18-lsp.md` records at its "the evidence extension remains severable"
paragraph; `core/tools/edit.ts` and `core/tools/write.ts` both declare
`emits: ["diff", "diagnostic"]` when a diagnostics backend is configured, and
`core/tools/diagnostics.ts` builds the record. This sentence is left standing as the record
of the 2026-08-19 state rather than rewritten. Landing LSP also found the token-budget figures
two paragraphs up were stale: unrelated tool-description growth across phases 5–8 had
already carried the measured prefix from 2,150 toward the 2,300 ceiling before LSP
registered anything. `ENFORCED_PRODUCTION_PREFIX_BUDGET` is now **2,500**, re-measured
rather than assumed — full record in the LSP spec's own closure amendment. The required
Ubuntu/macOS/Windows run (32332670645, green) caught two real cross-platform bugs this
plan's own Linux-only authorship couldn't see — a macOS diagnostics URI mismatch and a
Windows async-close race in test cleanup, both fixed and both recorded in the LSP spec's
closure amendment. `docs/plans/2026-08-18-lsp.md` is deleted; the spec above is now the
durable record.


**Follow-up (2026-08-20 — LSP.6 diagnostic evidence accepted and implemented, spec Complete.)** ADR
[0020](adr/0020-diagnostic-evidence-kind.md) is Accepted. `edit` and `write` now add a
bounded `"diagnostic"` evidence record when their diagnostics operation runs: selected
server where known, total and severity counts, explicit collector truncation, and a
stable unavailable classification. Diagnostic messages and free-form server errors stay
out of the durable ledger. The no-LSP path remains unchanged and emits no diagnostic
record. This 2026-08-20 amendment supersedes the earlier 2026-08-19 deferred state of LSP.6;
all tasks (LSP.1–LSP.7) are now complete, and the [LSP spec](specs/2026-08-18-lsp.md) is marked `Complete`.

---

## Phase 5 — Delegation & multi-agent

**Objective.** Subagents that cannot exceed their parent's authority.

**Scope.** Build on `pi-subagents`' decomposition rather than from zero — its
`capability-ceiling`, `preflight`, and `control-channel` are the right primitives, and
existing ADRs 0009 and 0024 already govern that dependency. Add Prime's recursion
depth guard (`rlmDepth` in the session header) and per-subagent artifact isolation.
Background work with retrievable results; inter-agent messaging only if a concrete
use case demands it.

**Exit criterion.** A child agent cannot obtain a grant its parent lacks (test).
Recursive delegation terminates at a bounded depth. Subagent artifacts never write
outside their own directory.

**Correction (2026-08-14 — the `pi-subagents` scope is restated; no such dependency
exists.)** The Scope paragraph above named `pi-subagents` as an existing dependency
supplying `capability-ceiling`, `preflight`, and `control-channel` primitives, governed
by "existing ADRs 0009 and 0024." Neither is real in this repository: no package named
`pi-subagents` appears in upstream Pi's ten-package inventory at the fork point
(`docs/upstream-log.md`) or anywhere in this repository's dependency graph; ADR 0009 is
reserved for telemetry, and there is no ADR 0024. The only delegation code that exists
is the bundled upstream example extension (`examples/extensions/subagent/`), which is
not a dependency and, per `docs/specs/2026-08-14-delegation-and-multi-agent.md`,
reconstructs authority from disk/argv rather than deriving it — a ceiling bypass by
construction. The scope is restated: delegation authority derives from the parent's
live in-memory permission state (store, mode, capability set), never reconstructed
across a process boundary, decided in ADR
`0008-delegation-authority.md` and detailed in the spec above.

---

## Phase 6 — Durable state & daemon

**Objective.** Survive crashes and support more than one client.

**Scope.** SQLite for auth, usage, model performance, and cache; FTS5 prompt history;
JSONL stays the session-of-record because the `id`/`parentId` tree is too good to give
up. Daemon + clients. Command journaling and snapshot cache (Prime's `daemon-workers/`)
so a long-running command survives a restart. Session leases for multi-client attach.
Git provenance in the session header.

**Exit criterion.** `kill -9` the daemon mid-command; on restart the command's state
is recovered from the journal. Two clients attach to one session without corrupting
it.

---

## Phase 7 — Evidence & verification

**Objective.** Distinguish "the agent said it passed" from "it passed." No other
harness reviewed can do this; it is the differentiator.

**Scope.** Move evidence *capture* into core — the bash tool records its own exit
code and argv, the edit tool its own patch hash and paths, the test runner its own
normalized executable. Port the existing `EvidenceRecord` union. Keep the SpecEngine,
gates, and governance policy as a **bundled extension**, switchable off and
independently testable — that separability is how the layer's calibration was earned.

**Exit criterion.** Evidence for bash, edit, write, and test is captured at the source
with no post-hoc reconstruction. The bundled policy extension consumes the durable
records independently. The Phase 7 audit found no tracked `gatedFailures()` corpus or
established threshold, so no numeric calibration claim is made until such a corpus is
introduced and measured.

**Risks.** The known self-measurement hazard: tests that drive a turn from the repo
root file synthetic rows into the evidence ledger. Carry the `inScratchRepo`
discipline forward from day one.

---

## Phase 8 — Observability & cost

**Objective.** Know what it costs and where the time goes.

**Scope.** Per-model, per-session, per-role cost and latency. OpenTelemetry export.
A status line worth reading. Carry OMP's accessibility settings across —
`symbolPreset: ascii`, `colorBlindMode`, configurable token-usage display. Cheap, and
almost nobody does it.

**Correction (2026-08-15, first — most of this phase is wiring, not new capability.)**
The Scope above reads as though none of it exists. Measured against the tree at
`035606611`, per-model and per-session cost **already ship**: `/session` renders token
totals with a cached/uncached split, total cost, a per-`provider/model` breakdown
(`getUsageCostBreakdown`), and cache re-billed waste (`computeCacheWaste`). What does
not exist is per-**role** attribution, **latency** in any surface (`SessionStats` has
no such field), and anything **cross-session**. The larger gap is upstream of all of
it: the per-request sample store built in Phase 1 is constructed **only in tests**, so
`instrumentAttempt` short-circuits on `if (!store) return stream;` in every real
session, and the `usage_totals`/`model_performance` tables Phase 6 declared have no
reader or writer anywhere in the repository. Phase 8's first task is therefore the
same shape as Phase 4's was: wire the production path, because until it lands every
gate below measures an empty table. Full inventory in
[the Phase 8 spec](specs/2026-08-15-observability-and-cost.md) § Current state.

**Correction (2026-08-15, second — the exit criterion is amended before
implementation.)** The original criterion read: *"Session cost reconciles with
provider billing within 5% over a one-week real-usage window."* It cannot be checked
by a reviewer, cannot run in CI, and requires a paid account plus a week of wall
clock — the defect ground rule 3 exists to prevent, and the one Phase 3 hit with its
median. It is amended **before** the work rather than at closure, and the amendment
makes the internal gate *stricter*: the 5% tolerance survives only where it belongs,
against an external bill we do not control, while internal arithmetic must reconcile
exactly.

**Exit criterion (amended).** All of the following, each checkable by someone other
than the author:

- Every model request attempt in a real session produces exactly one attributed
  durable sample (provider, model, role, outcome, ttft, generation, tokens, cost),
  observed through the production wiring rather than a test-constructed store; a
  rotated-away credential attempt records its own row.
- The durable ledger's per-session cost aggregate equals `getUsageCostBreakdown()`
  over that session's entries **exactly** — equality, not a tolerance. Two cost
  projections exist by design; this is what stops them drifting (ADR 0010's
  principle, applied outside the tool registry).
- With no OTLP endpoint configured, a full turn produces zero outbound requests
  attributable to observability.
- The footer conveys context pressure through a channel other than colour at default
  settings, and `symbolPreset: ascii` renders no codepoint above U+007F.
- A version-3 durable-state database migrates to version 4 without data loss.

**Carried, not discharged.** Recorded cost within 5% of a real provider invoice
remains owed, with `apex-code cost --since` as the named artifact for running it. It
is a post-landing obligation recorded as a further amendment when performed — the
same posture Phase 0 used for its amended criteria and Phase 7 used for its declined
calibration claim. Phase 8 may be marked landed on the gates above; the obligation is
never quietly ticked.

**Closure (2026-08-16) — all five amended exit-criterion gates met, verified test-first
across 7 tasks (8.1–8.7).** `SqliteUsagePerformanceStore` is now constructed at
`agent-session-services.ts` on every real session — the first production caller of
`openDurableStateStore` this repository has ever had, since `DurableStateDaemon`
(Phase 6) has no caller of its own outside its own test. One durable, session-attributed
row is recorded per model request attempt (2 under forced credential rotation),
verified through the actual production path, not a test-constructed store. The
durable-state schema moved 3 → 4: `model_performance` gained ten columns and
`usage_totals` — never written by any production code — was dropped. The
reconciliation gate holds exactly: a session mixing assistant messages, a tool-result
usage entry, and a compaction entry sums to the identical total via the ledger's new
`aggregateUsagePerformance()` and via the pre-existing `getUsageCostBreakdown()`,
resting on a real, source-verified fact rather than an assumption — compaction and
ordinary turns share the same `modelRuntime.streamSimple`-backed `streamFn`
(`sdk.ts` wires it directly; `context/pipeline.ts`'s wrapper always delegates to the
previous function). `apex-code cost [--by model|session|role] [--since <duration|
date>]` reads that same aggregation, wired at the real CLI dispatch. `/session` adds
Latency and Roles sections, additive and omitted (not shown empty) when the ledger
has no rows for that session. OTLP export is a documented, on-the-record scope
narrowing to span-per-request-attempt rather than a full turn/tool-call tree — the
same unit the ledger already records, reusing `instrumentAttempt` rather than opening
a new integration into `agent-session.ts`'s tool-call lifecycle; off unless
`observability.otlpEndpoint` is set (zero `fetch` calls verified unconfigured),
attributes an explicit ADR 0012 allowlist, egress via global `fetch` so a configured
proxy is honoured. The footer's WCAG 1.4.1 color-only failure is fixed by default (a
`!`/`!!` text marker at the 70%/90% thresholds, unconditional); `symbolPreset: ascii`
was verified by checking every codepoint in a full render, not spot-checking known
glyphs; `colorBlindMode` was first built as `chalk.bold`, and the test itself caught
that chalk's style methods silently no-op outside a real TTY — corrected to a real
palette swap (`error` → `accent`) using the same raw-ANSI path already proven to
survive stripping.

Full verification: `npx tsgo --noEmit` and `npm run build` clean. `npx biome check`
(repo-wide) shows 39 pre-existing errors with zero overlap against this phase's
changed files, cross-referenced by diff rather than assumed. Full `npm test` from
`packages/coding-agent`: 2356 passed / 53 skipped of 2414 tests; the 5 failures are
`external-editor`'s already-characterized pre-existing 3 (Phase 2b), plus two that
looked new but reproduced as CPU-contention timeouts under full-suite parallel load —
both passed clean in isolation and neither references any file this phase touched.
Per `AGENTS.md`'s plan lifecycle convention, `docs/plans/2026-08-15-observability-
and-cost.md` is deleted now that Phase 8 is landed (recoverable via `git show
<commit>:docs/plans/2026-08-15-observability-and-cost.md`); its durable content
lives in this section, the spec, and ADR 0012.

---

## Phase 9 — Release hardening

**Objective.** A stranger installs it and it works.

**Scope.** Versioned releases and an update path (exercised since Phase 0, hardened
here). Install on all supported platforms. **Session-format migration**: the
distributable posture means a format bump must migrate existing sessions, not orphan
them — Pi's own v1→v2→v3 auto-migration is the model. User documentation, not just
`docs/`. Security disclosure process. Opt-in-only telemetry with a published list of
what is collected (ADR-0009). Third-party attribution.

**Exit criterion.** Fresh install succeeds on all supported platforms from the
published artifact. An upgrade across a session-format version bump preserves and
correctly renders pre-upgrade sessions. A security disclosure path is published and
monitored.

**Closure (2026-08-16) — 6 of 6 tasks, verified test-first.** Mostly repair and
verification, the same shape Phase 8 turned out to have. Two real, verified bugs
closed, both independent of any settings default: `checkForNewPiVersion` compared
Apex Code's own version against **Pi's** latest release, unconditionally, on every
interactive startup — since the two projects' versions are unrelated sequences,
this almost always produced a false "Update Available" banner naming Pi's version
and linking to Pi's changelog. Repointed at the npm registry's `next` tag for this
package — no new endpoint required, npm already has the right data.
`reportInstallTelemetry()`, a separate `pi.dev` ping, is removed outright. The
"opt-in analytics" setting was not merely dead code: `first-time-setup.ts` actively
asked every new user to consent to it, promising a `/privacy` command that has never
existed anywhere in the tree, under Pi's name. Removed; onboarding is theme-selection
only now. **ADR 0009**, reserved since Phase 0's ADR table, is written and settles
the real finding: there is no working or intended project-directed telemetry to make
opt-in, because neither mechanism above was ever project-directed telemetry working
as designed — one was misdirected at upstream, the other was inert. Provider
attribution headers (a real, separate mechanism — billing-origin tags sent to the
user's own configured LLM provider) are kept, rebranded from `pi`/`Pi`, and governed
by a new, honestly-named `sendProviderAttribution` setting so a user who'd already
opted out under the old setting's name doesn't silently lose that choice.

Session-format migration (v1→v2→v3, inherited, unchanged by any Apex Code phase)
gained real test coverage through the production `SessionManager.open()` load path
— content-equivalence (message text, tool calls, usage), not just `id`/`parentId`
linkage — filling the gaps a pre-existing but narrower test left (missed by this
spec's own first-pass `grep` for internal function names, corrected before
implementing). `NOTICE`'s standing promise of a consolidated license report is kept:
a dependency-free script reads installed packages' own `license` fields, wired into
the release pipeline. The release pipeline now verifies a clean install on macOS as
well as Ubuntu, structurally proven never to re-run the actual publish steps. Every
concrete claim in the new `docs/user-guide.md` and the corrected README (which had
drifted to claiming "pre-alpha, Phase 0" with Phase 8 landed) was checked against
real CLI help text and slash-command definitions, not recalled.

Closure verification caught a real regression from its own earlier work: two
self-update tests mocked the old custom API's response field (`packageName`)
against code that now reads npm's actual registry field (`name`); the mocks
silently stopped matching and the tests began passing for the wrong reason
(exercising the ordinary-upgrade fallback, not the rename-detection path they
were meant to prove). Fixed by correcting the mocks, not the working code —
rename-detection still functions end to end, verified once the test spoke the
right vocabulary again (`test/package-command-paths.test.ts`: 27/27 passing after
the fix). `npx tsgo --noEmit`, `npm run build`, and `npm run check` (biome,
pinned-deps, ts-imports, shrinkwrap, install-lock) all clean, including 29 files of
pre-existing mechanical formatting debt found and fixed along the way, reviewed
change-by-change to confirm no logic moved. Full suite from `packages/coding-agent`:
1 failed file / 3 failed tests / 279 passed / 6 skipped (286 files; 2358 passed / 53
skipped of 2414 tests) — the only failures are `external-editor`'s already-documented
pre-existing ones (Phase 2b's characterization); `package-command-paths.test.ts`
passes clean, confirming the regression fix held under full-suite conditions, not
just in isolation. `SECURITY.md`'s stale "not hardened until Phase 9" banner
— which conflated release hardening with the permission gate and sandbox that
actually landed in Phase 2 — is corrected. Per `AGENTS.md`'s plan lifecycle
convention, `docs/plans/2026-08-16-release-hardening.md` is deleted now that Phase 9
is landed (recoverable via `git show <commit>:docs/plans/2026-08-16-release-hardening.md`);
its durable content lives in this section, the spec, and ADR 0009.

**Carried, not discharged.** "Monitored" in the exit criterion above is an
operational commitment — someone watching the GitHub private-vulnerability-reporting
inbox — not something a test can prove. The disclosure *path* is published and
verified accurate against current code; whether it is staffed is outside what this
phase's verification can close.


---

## Phase 10 — Complete the Apex Code product surface

**Objective.** An installed `apex-code` artifact identifies, documents, launches, and
updates one product — Apex Code — while preserving explicitly classified upstream and
ecosystem compatibility.

**Scope.** Repair external-editor argv handling; make `APEX_CODE_*` canonical behind a
bounded compatibility layer; correct live help, diagnostics, system prompt, npm README,
and shipped docs; make npm install/update and publishing coherent; repair documentation
lifecycle drift; and require the portable build/test surface on Ubuntu, macOS, and
Windows from a checkout path containing a space. Windows sandbox enforcement remains
unsupported under ADR 0005.

The phase does not change the two remaining `pi.dev` defaults. It renames the share
viewer variable interface only; Phase 11 decides hosted-service defaults after this
phase exits.

**Exit criterion.** Required Ubuntu, macOS, and Windows CI passes install, build, check,
and the full root test suite from an asserted checkout path containing a space. The
packed npm artifact launches and updates as `apex-code`, documents real network/privacy
and `.apex-code` behavior, and contains no current Pi product/executable instruction
outside a reviewed upstream, compatibility, attribution, or historical classification.
Every retained Apex-owned `PI_*` alias has tested Apex-first precedence, one diagnostic
per process, subprocess compatibility where owed, and a published removal rule.

**Current state.** Landed. Required Ubuntu, macOS, and Windows jobs passed install,
build, check, and the full root test suite from the asserted spaced checkout in
[CI run 31940072123](https://github.com/Fchery87/apex-code/actions/runs/31940072123).
See the [spec](specs/2026-08-16-complete-apex-product-surface.md) for the durable outcome.

**Product-surface follow-up (2026-08-23).** Terminal interaction polish is complete without
reopening Phase 10: explicit tool lifecycle cards, a responsive safety-first status tray,
bounded disclosure, delegation summaries, contextual hints, composer refinement, and a
common configuration index. Implemented in `ec752d593`, `ed465e209`, `74b3ccd68`, and
`697746b94`; see the durable [spec](specs/2026-08-23-terminal-interaction-polish.md).

---

## Phase 11 — Remove unowned hosted-service defaults

**Objective.** A fresh Apex Code install depends on no hosted functional service that
the project does not operate; remote catalog and viewer integrations require explicit
user configuration, and session publication requires informed confirmation.

**Scope.** Replace the implicit `pi.dev` model-catalog overlay with a user-named endpoint,
make the share viewer optional, disclose and confirm secret-Gist publication, bind catalog
caches to their source, and correct the packed product documentation. Do not operate new
Apex infrastructure or change consumed provider definitions.

**Exit criterion.** Fresh-default tests prove zero catalog/viewer selection, explicit
integrations retain their existing behavior without cross-origin cache reuse, `/share`
cannot publish before confirmation, and required Ubuntu/macOS/Windows install, build,
check, and full tests pass from the spaced checkout.

**Current state.** Landed. Required Ubuntu, macOS, and Windows jobs passed the
spaced-checkout assertion, install, build, check, and full root test suite in
[CI run 31945192886](https://github.com/Fchery87/apex-code/actions/runs/31945192886).
See the [spec](specs/2026-08-16-remove-unowned-hosted-service-defaults.md) for the durable
outcome; ADR 0013 settles the hosted-service policy.

---


## Phase 12 — Production graduation and release integrity

**Objective.** Make a release byte-identifiable, safely installable, honestly branded, and
supportable by the current sole maintainer before Apex Code claims beta or stable support.

**Scope.** Close the published-artifact drift that served Pi-branded `apex-code@next`; add
packed-artifact and rendered-startup identity gates; repair sandbox credential/state handoff
and trust-first security policy resolution; verify downloaded executable tools; replace the
inherited all-workspace release assumptions with an Apex-only path; add supply-chain evidence;
and publish the sole-maintainer support and security operating policy.

**Exit criterion.** A release commit produces byte-identified Apex-owned tarballs whose packed
README, compiled runtime, startup surfaces, system prompt, metadata, exact dependency, tag, and
registry `gitHead` agree. Pre-publication Linux/macOS artifact installs complete a provider-
independent sandbox/session smoke; required Ubuntu/macOS/Windows CI passes; credentials and
trusted policy cross the sandbox boundary only through tested least-privilege paths; downloaded
executables reject unverified artifacts; Apex-only release tooling leaves frozen packages
untouched; security/support ownership and the latest-supported-release policy are published.
This phase does not claim Windows sandbox enforcement or 24/7 support.

**Current state.** Landed. All 15 plan tasks complete: security-boundary ADRs
(0015, 0016), the sandbox credential/state handoff and trust-first policy resolution, pinned
and verified tool-artifact installation (ADR 0017), Apex-only release/version tooling (ADR
0018 — which also found and fixed a real, previously-latent defect: inherited release scripts
would have bumped and corrupted the six frozen upstream packages' own `package.json`/
`CHANGELOG.md` files on the next version bump), the pre-publication packed-artifact identity
and functional-smoke gate, post-publication registry/provenance verification, supply-chain
evidence (Dependabot, `npm audit`, SBOM, scoped production license closure, a durable
release-evidence manifest), the published sole-maintainer support policy and governance
checklist (`docs/support.md`, `docs/release-integrity-runbook.md`,
`docs/release-governance-checklist.md`), and full verification. A full unscoped `npm test` run
is clean: 2811 tests passed, 0 failures. Required [CI run
31993235802](https://github.com/Fchery87/apex-code/actions/runs/31993235802) passed Ubuntu,
macOS, Windows, and the frozen-package-boundary job from the asserted spaced checkout — after
four real, previously-latent cross-platform bugs were found and fixed through iterative
required-CI runs (a Linux sandbox fd leak, Windows npm/npm.cmd shell invocation, Windows shell
argument quoting for the spaced checkout path, and a Windows/macOS test-fixture mismatch),
exactly the kind of defect three-OS CI exists to catch and this Linux-only dev environment
cannot. 12.15 (publish the corrected prerelease) is also complete: `apex-code@0.0.1-alpha.2`
and `apex-code-agent-core@0.0.1-alpha.2` are published on the npm `next` tag, verified via
[release.yml run 32030755704](https://github.com/Fchery87/apex-code/actions/runs/32030755704)
(registry `gitHead`, tarball hash, and provenance all matched; clean installs passed on
Ubuntu and macOS), and the stale `0.0.1-alpha.0`/`0.0.1-alpha.1` versions of both packages
are deprecated. See the plan's task 12.15 row for the full defect list this uncovered and
fixed in the release tooling itself along the way. The published `apex-code@next` artifact
now matches current `main`. Getting there surfaced and fixed five further real defects beyond
the packed-artifact identity gate itself: stale/broken Pi-branded content across 29 packed
`docs/*.md` files and a misdirected runtime link in `src/migrations.ts` (root cause: the
identity gate only ever scanned `README.md`, not the rest of `docs/`, now fixed); `release.mjs`
could not produce a prerelease version at all despite task 12.7 requiring prerelease-semver
support, and would have staged a frozen-package violation via its model-regeneration step;
a hardcoded version literal in `test/apex-identity.test.ts`; and two defects `release.yml`'s
own real tagged run was the first thing ever to exercise end-to-end — a missing `bubblewrap`
system dependency (present in `ci.yml` but never ported over) and `actions/upload-artifact`'s
default exclusion of dot-prefixed ("hidden") paths silently dropping the SBOM upload from the
gitignored `.artifacts/` directory.

See the [spec](specs/2026-08-16-production-graduation-and-release-integrity.md) and the
[research](research/2026-08-16-production-operations-and-release-integrity.md) for the durable
outcome.

## ADRs to write

These are the irreversible or contested calls. Each gets settled once, in
`docs/adr/`, and stops being re-argued.

Numbers are allocated when an ADR is **written**, not when its phase is forecast.
Rows below without a written file are reservations; an ADR written ahead of its phase
takes the next free number instead of a reserved one.

| # | Decision | Phase | Written |
| --- | --- | --- | --- |
| 0001 | Fork boundary: `coding-agent` + `agent-core` forked; `pi-ai`, `pi-tui` consumed | 0 | ✅ |
| 0002 | Clean-room rule regarding `c-code`; behavior may be described, code never copied | 0 | ✅ |
| 0003 | Upstream merge cadence, patch-surface ceiling, and abandonment tripwire | 0 | ✅ (ceiling pending) |
| 0004 | Permission rule model and source precedence | 2a | ✅ |
| 0005 | What the sandbox boundary does and does not guarantee | 2b | ✅ |
| 0006 | Session format ownership and the migration guarantee owed to users | 6 | ✅ |
| 0007 | Evidence capture in core; policy layer stays a bundled extension | 7 | ✅ |
| 0008 | Delegation authority: in-process derived child vs. subprocess with serialized authority | 5 | ✅ |
| 0009 | Telemetry: opt-in only, and exactly what is collected | 9 | ✅ |
| 0010 | One canonical tool contract, declared by the tool and never re-derived | pre-2 | ✅ |
| 0011 | Deferred schemas resolve through an explicit model-callable tool, not harness-side injection | 4 | ✅ |
| 0012 | User-directed OTLP export is not project telemetry; the two never share a switch | 8 | ✅ |
| 0013 | Hosted functional-service defaults require project ownership or explicit user choice | 11 | ✅ |
| 0014 | Sole-maintainer production operations, support targets, and succession | 12 | ✅ |
| 0015 | Host-owned credentials with an explicit sandbox read-only handoff | 12 | ✅ |
| 0016 | Trust-first supervisor policy inputs | 12 | ✅ |
| 0017 | Downloaded tool artifact integrity: pinned metadata, bounded/verified/atomic install | 12 | ✅ |
| 0018 | Apex-only release/version authority and artifact contract | 12 | ✅ |
| 0019 | Brand mark, palette, and input chrome | follow-up | ✅ |
| 0020 | Diagnostic evidence kind, emitted by the tool that produced the diagnostic | follow-up | ✅ |
| 0021 | Skill catalog is name-only and budget-bounded; descriptions resolve through a model-callable tool | follow-up | ✅ |
| 0022 | Ember palette, a mark that does not shrink, and a counted startup | follow-up | ✅ |
| 0023 | Escalation authority belongs to the supervisor, not the child | follow-up | ✅ |
| 0024 | Per-command escalation runs a second child, never widens the first | follow-up | ✅ |
| 0025 | MCP rule grammar: `Mcp(server:tool)`, wildcard in the tool position only, metadata separate | follow-up | ✅ |
| 0026 | npm dist-tags derive from the release version: prerelease to `next`, stable to `latest` | follow-up | ✅ |

## Cross-phase contracts

Some interfaces are written to by several phases and cannot be designed inside any
one phase's spec. They live in `docs/architecture/contracts.md`, which records each
as **settled** (specified, with an ADR) or **open** (consumers and questions
recorded, decision deferred to the phase that first writes to it).

| Contract | Status | Consumers | Settle by |
| --- | --- | --- | --- |
| Tool contract | Settled — ADR 0010 | 2, 3, 4, 5, 7 | done |
| Context pipeline order | **Settled** 2026-08-13 | 3, 7 | — |
| Session entry schema | **Settled** — ADR 0006 | 1, 5, 6, 7, 9 | settled at Phase 6 (`baf5e5302`) |

---

## Explicitly not building

Defended non-goals, so they stop coming back:

- **A React/Ink TUI.** `pi-tui` has two runtime dependencies. Ink is the largest
  copy-temptation in `c-code` and would import a rendering framework and its startup
  cost for aesthetics the terminal does not reward.
- **Our own provider layer.** `pi-ai` is the best thing in any of the reviewed
  systems and the part of Pi that needed no improvement. Rewriting 35 providers ×
  9 API dialects is the most tempting and most wasteful thing available.
- **A feature-flag / experimentation platform.** `c-code` threads `feature()` calls
  through everything and pulls in a full experimentation vendor. A single-maintainer
  OSS harness does not carry that.
- **A monolithic query loop.** Take c-code's recovery *behaviors* — output-token
  recovery, reactive compaction, turn caps, budget tracking — onto Pi's loop
  structure. Its 1730-line generator over mutable state is not the shape to copy.
- **A model-evaluation suite.** Already litigated in
  `docs/plans/2026-07-27-harness-simplification-plan.md` Task 1.1: the one that
  existed called no model and fabricated its numbers. The Phase 0 replay corpus is
  the honest, affordable version. Re-proposing a full eval suite must re-open that
  framing decision, not resume a paused phase.
