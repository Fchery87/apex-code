# Apex Code — roadmap

*A provider-agnostic agentic harness forked from Pi.*

**Status:** Active — Phases 0 through 9 landed · Phase 10 active · **Created:** 2026-08-08 · **Last updated:** 2026-08-16

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
| 10 | Complete the Apex Code product surface | **active** — 0 of 7 tasks | [spec](specs/2026-08-16-complete-apex-product-surface.md) | [plan](plans/2026-08-16-complete-apex-product-surface.md) |

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
  allowlist, a violation store, and an interactive escalation callback. ADR-0005
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
| **2b — OS sandbox** | Filesystem read/write restriction, network host allowlist, violation store, interactive escalation. ADR 0005. | The sandbox blocks a write outside the workspace and a request to a non-allowlisted host, and both surface as violations rather than silent failures. |

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

**Current state.** Active. See the [spec](specs/2026-08-16-complete-apex-product-surface.md)
and [plan](plans/2026-08-16-complete-apex-product-surface.md).

---

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

## Cross-phase contracts

Some interfaces are written to by several phases and cannot be designed inside any
one phase's spec. They live in `docs/architecture/contracts.md`, which records each
as **settled** (specified, with an ADR) or **open** (consumers and questions
recorded, decision deferred to the phase that first writes to it).

| Contract | Status | Consumers | Settle by |
| --- | --- | --- | --- |
| Tool contract | Settled — ADR 0010 | 2, 3, 4, 5, 7 | done |
| Context pipeline order | **Settled** 2026-08-13 | 3, 7 | — |
| Session entry schema | Open | 1, 5, 6, 7, 9 | start of Phase 6 (entries logged as they land from Phase 1) |

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
