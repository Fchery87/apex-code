# Research: the Pi-lineage harness landscape, September 2026

**Date:** 2026-09-25  
**Status:** Permanent research note  
**Scope:** Which public harnesses fork or build on Pi (`earendil-works/pi`, formerly
`badlogic/pi-mono`), what they ship that Apex Code does not, and which of those
features Apex Code should take. Apex state measured at `707f96d91`.

> **Provenance.** Every upstream fact below comes from a public, licensed repository or
> its first-party documentation, cited with a URL pinned to the commit read on
> 2026-09-25. No unlicensed source was opened (ADR 0002). Upstream sources were read for
> *behavior*; nothing here is a transcription of their code. Star counts and push dates
> come from `gh api repos/<owner>/<repo>` on 2026-09-25 and will drift.

## 1. Why this exists

The 2026-08-08 comparative review studied Oh My Pi (OMP) and Prime Agent only as
installed state — "state inspected, no source" with no license recorded. Both are now
public MIT repositories with extensive feature docs, and the Pi ecosystem has grown a
second tier of derivatives. This note replaces the installed-state view with a
documented one and builds on four earlier notes rather than repeating them:
[`2026-08-08-harness-comparative-review.md`](2026-08-08-harness-comparative-review.md),
[`2026-08-23-prime-agent-tui-reference.md`](2026-08-23-prime-agent-tui-reference.md)
(Prime's TUI, not repeated here),
[`2026-09-22-antigravity-cli-comparison.md`](2026-09-22-antigravity-cli-comparison.md),
and [`2026-09-23-codex-cli-comparison.md`](2026-09-23-codex-cli-comparison.md).

## 2. How the candidates were found

- `gh search repos "pi-coding-agent" --sort stars` — mostly multi-harness tools that
  list Pi as one supported agent; the Pi-built entries are below.
- `gh api repos/earendil-works/pi/forks?sort=stargazers` — 13,902 forks, but the top
  GitHub-network fork has 102 stars (`mitsuhiko/pi-mono`). The notable derivatives are
  **hard forks outside the fork network** or **packages that depend on Pi**, not GitHub
  forks. Ranking by fork-network stars would miss every one that matters.
- `gh search code` for `@earendil-works/pi-coding-agent` and
  `@mariozechner/pi-coding-agent` in `package.json` — about 130 hits, nearly all single
  Pi extensions (`pi-subagents`, `pi-web-access`, `pi-mcp-adapter`, `pi-review`, …).
  Extensions are out of scope except where a harness below bundles them.

## 3. Observed upstream behavior

### 3.1 The landscape

| Project | Relation to Pi | Stars | Last push | License | Kind |
| --- | --- | --- | --- | --- | --- |
| [`earendil-works/pi`](https://github.com/earendil-works/pi) | Upstream | 109,361 | 2026-09-25 | MIT | Base (ADR 0001) |
| [`openclaw/openclaw`](https://github.com/openclaw/openclaw/tree/52c7502c8613d02e5fda0c7d36dd7ed5d544ba71) | Consumes `@earendil-works/pi-tui` 0.85.1; credits Pi | 390,515 | 2026-09-25 | MIT (GitHub reports "Other"; `LICENSE` is MIT text) | Personal assistant over chat channels |
| [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi/tree/7853b4e499936f9dcc13c9b64adb55f6b342aabf) (OMP) | Hard fork of pi-mono | 33,302 | 2026-09-25 | MIT (+ vendored third-party notices) | Coding harness |
| [`PrimeIntellect-ai/prime-agent`](https://github.com/PrimeIntellect-ai/prime-agent/tree/cd1f215cffd09223316c54dddae5e1b654718c31) | Hard fork; keeps `@earendil-works/pi-*` identifiers | 21,295 | 2026-09-25 | MIT | Coding + research harness (RLM) |
| [`Companion-Inc/feynman`](https://github.com/Companion-Inc/feynman/tree/87cefb931372cd068dd48ec467ed0500e538c39f) | Stock Pi + a Pi package | 9,788 | 2026-09-25 | MIT | Research agent |
| [`vastsa/PI-Desktop`](https://github.com/vastsa/PI-Desktop/tree/ccf66728c6924b0be03d7ffa2ded35b717ac8070) | Uses `pi-ai` + `pi-agent-core` | 5,738 | 2026-09-25 | **LGPL-3.0** | Electron desktop workspace |
| [`huggingface/tau`](https://github.com/huggingface/tau) | Python port, no shared code | 2,858 | 2026-09-23 | MIT | Minimal agent |
| [`Gentleman-Programming/gentle-shell`](https://github.com/Gentleman-Programming/gentle-shell/tree/545681161ad04ee8df94a789669123a3186894d6) | Pi package + launcher over stock Pi | 1,089 | 2026-09-25 | MIT (names trademarked) | Coding workspace |

OpenClaw is the largest Pi-lineage project but is a chat-channel assistant with a
gateway, not a coding harness; it is recorded for completeness and not mined below.
`tau` shares no code. PI-Desktop is LGPL-3.0: its behavior may be described, but its
code must not be copied into an MIT product. The detailed survey covers OMP, Prime,
Gentle Shell, Feynman, and PI-Desktop.

### 3.2 Oh My Pi (OMP)

Pinned to `7853b4e`; README line anchors are against that commit.

- **Review with a verdict.** `/review` spawns reviewer subagents in parallel over a
  branch, one commit, or uncommitted work, ranks every finding P0–P3 with a confidence
  score, and returns a ship/no-ship verdict. `/annotate code-review` lets the user pin
  notes to diff lines before reviewers run.
  [README L201-L205](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/README.md#L201-L205)
- **Advisor ("watchdog") model.** An optional second model, bound to an `advisor` model
  role, reviews each primary-agent update with a read-only toolset by default and injects
  notes graded `nit` / `concern` / `blocker`. It does not approve actions or mutate the
  primary session. Guardrails: an emission guard with severity-aware dedupe and a
  per-update note budget (default 4), `immuneTurns` (default 3) throttling interruptions,
  no auto-resume after a user interrupt, and a separate `__advisor.<slug>.jsonl`
  transcript. `WATCHDOG.md` is advisor-only guidance; `WATCHDOG.yml` is a roster of
  specialised advisors. `-p --advisor` enables it headless.
  [advisor-watchdog.md](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/advisor-watchdog.md),
  [README L173-L179](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/README.md#L173-L179)
- **Time-traveling stream rules (TTSR).** Rules carry a regex, an ast-grep pattern, or a
  judged question. They cost no prompt tokens until matched; a match in assistant text or
  tool arguments aborts the stream, injects the rule as a system reminder, and retries.
  Rules are scoped per stream, per tool, and per path glob, and injections survive
  compaction.
  [ttsr-injection-lifecycle.md](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/ttsr-injection-lifecycle.md),
  [README L155-L161](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/README.md#L155-L161)
- **Subagents with typed results and a live hub.** `task` fans out into optionally
  isolated worktrees, and each worker's final yield is a schema-validated object the
  parent reads directly. `Alt+A` opens Agent Hub: a roster (`running`/`idle`/`parked`/
  `aborted`, model, age, current task), live transcripts, steering, revive, and kill
  without aborting the parent. Parked subagents are rediscovered on resume.
  [README L163-L171](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/README.md#L163-L171),
  [agent-hub.md](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/agent-hub.md)
- **Hashline edits.** The model addresses lines by content-hash anchors rather than
  retyping them; stale anchors reject the patch. OMP's vendor-published benchmarks claim
  large gains on weaker models (for example, Grok Code Fast 1 from 6.7% to 68.3%). These
  are **vendor claims, not independently verified**.
  [README L111-L127, L207-L209](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/README.md#L111-L127)
- **Memory.** Off by default. Backends `local`, `hindsight`, `mnemopi`, `sharpshooter`;
  a consolidated project summary is injected at session start under a token limit, with
  explicit guidance that memory is heuristic and loses to current repo state. Tools
  `retain`, `recall`, `reflect`, `learn`, `memory_edit`.
  [memory.md](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/memory.md)
- **Context-file interop.** Reads rules, skills, and MCP config from `.claude`,
  `.cursor`, `.windsurf`, `.gemini`, `.codex`, `.cline`, `.github/copilot`, `.vscode` in
  their native formats.
  [README L223-L225, L573-L575](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/README.md#L223-L225)
- **Other surface**, not recommended below: a DAP debugger tool, `ast_grep`/`ast_edit`
  with preview-then-accept, persistent Python/JS `eval` cells, ~80k lines of Rust for
  in-process grep/glob and 58 coreutils, `/collab` relay-shared live sessions, browser
  and desktop control, `omp commit` atomic splitting, `pr://`/`conflict://` URL schemes,
  magic keywords (`ultrathink`, `orchestrate`), image generation, TTS.
  [README L133-L313](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/README.md#L133-L313)
- **Already matched by Apex:** model roles with per-role fallback chains, round-robin
  credentials with per-credential backoff, ACP, RPC, SDK, LSP.
  [README L382-L388](https://github.com/can1357/oh-my-pi/blob/7853b4e499936f9dcc13c9b64adb55f6b342aabf/README.md#L382-L388)

### 3.3 Prime Agent

Pinned to `cd1f215`. `LRA` below is
[`packages/coding-agent/docs/long-running-agents.md`](https://github.com/PrimeIntellect-ai/prime-agent/blob/cd1f215cffd09223316c54dddae5e1b654718c31/packages/coding-agent/docs/long-running-agents.md).

- **Persistent goals.** `/goal [--budget N] <objective>` keeps an objective active across
  turns until it is completed, paused, budget-limited, errored, or cleared. The harness
  keeps prompting an active goal after ordinary turns; only an explicit `goal.complete()`
  marks success. Goal state records tokens, elapsed time, and continuation count. A goal
  is an explicit user action, never inferred. [LRA L172-L197](https://github.com/PrimeIntellect-ai/prime-agent/blob/cd1f215cffd09223316c54dddae5e1b654718c31/packages/coding-agent/docs/long-running-agents.md#L172-L197)
- **Bounded autonomous mode.** `/autonomous on` or `--autonomous` adds continuations until
  configured quality gates (`--gate "npm run check"`) pass or a continuation, turn, token,
  or wall-clock limit is hit. A failed gate returns bounded output to the agent; the same
  failed gate is not rerun on an unchanged workspace. Continuations are held while
  subagents or background shells run, so waiting does not burn budget. The docs state
  that a passed gate proves only what it checks. [LRA L199-L260](https://github.com/PrimeIntellect-ai/prime-agent/blob/cd1f215cffd09223316c54dddae5e1b654718c31/packages/coding-agent/docs/long-running-agents.md#L199-L260)
- **Heartbeats and schedules.** `/heartbeat every 10m …` re-enters a session on an
  interval; `prime-agent schedule add <agent> "0 9 * * 1-5" -- …` takes one-time or cron
  prompts. Due ticks are claimed before delivery so a crash cannot replay an uncertain
  prompt, and missed ticks coalesce. Requires the daemon. [LRA L112-L170](https://github.com/PrimeIntellect-ai/prime-agent/blob/cd1f215cffd09223316c54dddae5e1b654718c31/packages/coding-agent/docs/long-running-agents.md#L112-L170)
- **Agent-to-agent messaging.** Running sessions and retained subagents message each
  other with delivery modes `auto`/`steer`/`follow_up`, receipts (`delivered`/`queued`),
  family-scoped broadcast, and daemon-enforced size, rate, and queue limits.
  [LRA L71-L110](https://github.com/PrimeIntellect-ai/prime-agent/blob/cd1f215cffd09223316c54dddae5e1b654718c31/packages/coding-agent/docs/long-running-agents.md#L71-L110)
- **Continual harness (`/refine`).** Reviews the trajectory and applies small,
  evidence-backed updates to *supplemental* prompts, memories, skill descriptions, or
  subagent specs, never the base system prompt, with snapshots for rollback.
  [README L58, L93](https://github.com/PrimeIntellect-ai/prime-agent/blob/cd1f215cffd09223316c54dddae5e1b654718c31/README.md#L58)
- **Side questions.** `/btw` or `/side <question>` asks inline without adding to the
  session. [usage.md L58](https://github.com/PrimeIntellect-ai/prime-agent/blob/cd1f215cffd09223316c54dddae5e1b654718c31/packages/coding-agent/docs/usage.md#L58)
- Its primary tool is a persistent Python REPL (RLM), and its README warns that worker
  and kernel isolation is not a security sandbox.
  [README L56, L76](https://github.com/PrimeIntellect-ai/prime-agent/blob/cd1f215cffd09223316c54dddae5e1b654718c31/README.md#L56)

### 3.4 Gentle Shell

Pinned to `5456811`. A Pi package plus a launcher that runs stock Pi in its own home.

- **Gentle Changes.** Captures successful `write`/`edit` tool calls from the session
  *and its owned subagents* — no repo scans or polling — in a two-pane viewer with
  per-file line counts. It states its own coverage limit: shell edits and failed runs
  leave no row, and "a missing entry never proves a clean tree"; an external edit shows
  "diff unavailable". [README L125-L131](https://github.com/Gentleman-Programming/gentle-shell/blob/545681161ad04ee8df94a789669123a3186894d6/README.md#L125-L131)
- **Native review** of one fixed candidate with risk-scoped evidence and a bounded
  correction path. [README L115-L121](https://github.com/Gentleman-Programming/gentle-shell/blob/545681161ad04ee8df94a789669123a3186894d6/README.md#L115-L121)
- **Gentle Agents.** Each subagent has a live card (model, tokens, cost, elapsed);
  `alt+a` shows retained threads and stop controls, history is restored on resume, a
  child can ask the user a question as a dialog, and background results start a new
  turn instead of polling. [README L135-L141](https://github.com/Gentleman-Programming/gentle-shell/blob/545681161ad04ee8df94a789669123a3186894d6/README.md#L135-L141)
- **Command palette** (`alt+k`) grouped by category and listing only registered
  commands; a TODO card that turns amber when the model lets it go stale.
  [README L155-L178](https://github.com/Gentleman-Programming/gentle-shell/blob/545681161ad04ee8df94a789669123a3186894d6/README.md#L155-L178)

### 3.5 Feynman and PI-Desktop

- **Feynman** runs on stock Pi and adds only a package: research workflows
  (`/deepresearch`, `/lit`, `/audit`, `/replicate`), four bundled agents (researcher,
  reviewer, writer, verifier), and `/btw` via the `pi-btw` extension. It sends
  **telemetry by default**, and editor use goes through the third-party `pi-acp`.
  [README L102-L160](https://github.com/Companion-Inc/feynman/blob/87cefb931372cd068dd48ec467ed0500e538c39f/README.md#L102-L160)
  Takeaway: Pi's package system carries a whole vertical product. It shows that an
  extension ecosystem pays off, but Feynman has no harness-level feature Apex lacks.
- **PI-Desktop** (LGPL-3.0) wraps `pi-ai` and `pi-agent-core` in an Electron + Rust
  workspace with three modes — Agent, Plan, and **Goal** ("lock the objective and
  acceptance criteria, then let the agent drive") — plus a session orchestrator
  coordinating parallel worker sessions, and an allow/ask/deny permission layer.
  [README L237-L299, L493-L512, L605-L614](https://github.com/vastsa/PI-Desktop/blob/ccf66728c6924b0be03d7ffa2ded35b717ac8070/README.md#L237-L299)

### 3.6 Convergence

Three signals appear across independent projects and are the strongest evidence here:

1. **A dedicated review command**: OMP, Gentle Shell, the `earendil-works/pi-review`
   extension, and Codex (2026-09-23 note). Antigravity's line comments (2026-09-22
   note) point the same way.
2. **Goal plus bounded continuation**: Prime (`/goal`, `/autonomous`), PI-Desktop (Goal
   mode), and Codex's thread goals.
3. **A live subagent view with steering**: OMP Agent Hub, Gentle Agents, and Prime's
   agents tile.

## 4. Measured Apex state (`707f96d91`, 2026-09-25)

Each gap in § 5 was checked with `grep -rli` over `packages/coding-agent/src`.

| Feature | Apex today | Evidence |
| --- | --- | --- |
| Review command | **absent**; the README "Review without changing files" workflow is `--permission-mode plan --print` | `core/slash-commands.ts` lists 27 built-ins, none a review; `README.md:446` |
| Goal / autonomous continuation | **absent**; configured verification exists and reports `verified`/`failed`/`continued-unverified` but does not drive further turns | 0 hits for `autonomous`, `/goal`, `heartbeat`; `core/verification-lifecycle.ts` |
| Changes view | **absent** as a surface; diff evidence is already captured at the source | `DiffEvidenceRecord` in `core/tools/contract.ts:212` |
| Live subagent view / child steering | **absent in the TUI**; RPC has `agent/status` and `agent/recover`, and `steer` targets only the root session | `modes/rpc/rpc-types.ts:31,52,55`; no child-run component in `modes/interactive/` |
| Typed child results | **absent**; `delegate` returns text `output` | `core/tools/delegate.ts:137-147` |
| Worktree-isolated children | **present** | `core/delegation/runtime.ts:178` |
| Advisor model | **absent** (the 6 `advisor` hits are "advisory" comments) | grep |
| Stream rules | **absent** | 0 hits for `ttsr`, `stream rule` |
| Side question (`/btw`) | **absent** | 0 hits |
| Memory tools | **absent** (the `memory` hits are in-memory data structures) | grep over `core/tools`, `core/system-prompt.ts` |
| Hashline edits | **absent**; `edit` is exact-text replacement with advisory failure diagnostics | `core/tools/edit-diff.ts:254-317` |
| Foreign context files | **partial**; `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, all trust-gated | `core/project-resources.ts:69-75` |
| Role fallback chains, credential pools | **present** | `core/model-runtime.ts:869-893` |

## 5. Recommendations for Apex Code

This section is design guidance, not a claim about the upstreams. Every roadmap phase
has landed, so each row would become a **product-surface follow-up** with its own spec.
The phase column names the phase whose contracts the work extends and whose ADRs it must
respect.

| # | Feature | Source harness | Value | Effort | Fits phase |
| --- | --- | --- | --- | --- | --- |
| 1 | **`/review` (and `apex-code review`)**: read-only over the working diff, a commit, or a base; findings ranked P0–P3 with `file:line`, a one-line reason, and a verdict; selected findings become the next prompt | OMP, Gentle Shell (+ Codex, Antigravity notes) | **High.** Four independent signals; clear read-only contract; runs in `plan` mode through existing delegation | M | 5 (delegation) + 7 (evidence) |
| 2 | **Goal + bounded continuation**: `/goal` records an objective; `--until-verified` / `/autonomous` continues until configured verification passes or a turn/token/time budget is hit; no rerun of a failed gate on an unchanged workspace; hold while children or background shells run | Prime, PI-Desktop | **High.** Apex already has the gate (`verification-lifecycle.ts`, which retires stale results on any workspace change) and the budgets (run aggregate); this closes the loop instead of adding a subsystem | M | 7 (evidence) + 5 (run budgets) |
| 3 | **Changes view**: a TUI panel and RPC query over `DiffEvidenceRecord`s for the session and its child sessions, with the coverage limit stated as Gentle Shell does | Gentle Shell | **High for its cost.** A pure projection of evidence already captured at the source; no new classifier (ADR 0010) | S–M | 7 (evidence) / 8 (observability) |
| 4 | **Agents view with child steering**: a roster of child runs (state, model, tokens, cost, age), open a live transcript, steer or cancel one child without aborting the parent; background results start a turn | OMP Agent Hub, Gentle Agents, Prime | **High.** Delegation is Apex's most capable subsystem and its least visible one. Must read the existing run-budget stream, as the Antigravity note warns | M | 5 (delegation) / 8 |
| 5 | **Typed child results**: optional `outputSchema` on `delegate`, validated before return, with a retry on invalid output | OMP | Medium. Makes #1 and #4 composable; shares a validator with the pending `--json-schema` follow-up (Codex note, rank 4) | S–M | 5 |
| 6 | **`/btw` side question**: an ephemeral turn that does not enter the session tree unless handed back | Prime, Feynman (`pi-btw`) | Medium. Cheap, popular, and the tree session format makes "not added" easy to express | S | Terminal polish (10) |
| 7 | **Stream rules**: regex- or path-scoped rules that cost zero prompt tokens until matched, then interrupt and inject | OMP | Medium. A direct context-engineering win (Phase 3's thesis) and complements declarative hooks. Needs a replay-corpus measurement of abort-and-retry cost against prompt caching before adoption | M | 3 (context) + hooks |
| 8 | **Advisor role**: an optional second model on the existing `roles` config, read-only by default, emitting graded notes through the steering queue, with a note budget, dedupe, and interrupt throttle; never an approver | OMP | Medium–high for quality, but it roughly doubles spend. Ship off by default, with its cost in the observability rollups | M–L | 1 (roles) + 8 (cost) |
| 9 | **Foreign context-file interop**: read `.cursor/rules`, `.clinerules`, `.github/copilot-instructions.md`, `GEMINI.md` | OMP | Medium adoption lever. Each spelling must join `PROJECT_INSTRUCTION_FILES` so it stays trust-gated (ADR 0034), not load through a side door | S | 10 (product surface) |
| 10 | **Hashline edit format as an opt-in `edit` variant** | OMP | Unknown. Vendor benchmarks only. Measure on the replay corpus with two weak models before shipping; the tool-surface token budget (2,300) constrains a second schema | M | 4 (tool surface) |
| 11 | Heartbeats and cron schedules | Prime | Low–medium. Depends on the Phase 6 daemon; needs a claim-before-deliver journal like Prime's | M–L | 6 (daemon) |
| 12 | Curated memory / `/refine` harness self-update | OMP, Prime | Low for now. Both treat memory as heuristic and rollback-able, which is the right shape, but it creates a new durable state class and a prompt-injection path. Revisit after 1–4 | L | 6 + 7 |

**Suggested order:** 3 and 6 are small and independent. 1 then 5 then 4 share the
delegation surface and should be specced together. 2 builds on the existing verification
lifecycle. 7 and 10 are measurement-gated through the replay corpus. 8 follows once 4
makes a second agent's notes visible.

### Declined, with reasons

- **In-process Rust coreutils and grep (OMP).** A large native surface for latency Apex
  has not measured as a bottleneck, and one that would raise upstream merge cost (ADR 0003).
- **`/collab` relay sharing (OMP).** Needs a hosted relay; Phase 11 removed unowned
  hosted-service defaults.
- **Browser, desktop control, image generation, TTS (OMP).** Each is better as an
  extension or MCP server than as a built-in, given the tool-surface budget.
- **Python REPL as the primary tool (Prime).** A different programming model. Prime's own
  README says its isolation is not a sandbox, and ADR 0032 already puts isolation on the
  operator.
- **Telemetry on by default (Feynman).** Contradicts ADR 0009.
- **Desktop app shell (PI-Desktop).** Out of scope. It is also LGPL-3.0, so any reuse
  would have to be behavioral only.

## 6. Corrections to earlier Apex notes

| Note | Said | Now verified |
| --- | --- | --- |
| 2026-08-08 comparative review | OMP and Prime: license "—", "state inspected, no source" | Both are public MIT repositories (`can1357/oh-my-pi`, `PrimeIntellect-ai/prime-agent`) with first-party docs, citable at a commit |
| 2026-08-08 comparative review | Upstream is `github.com/earendil-works/pi` | Still correct; `badlogic/pi-mono` now redirects there |

## 7. What this feeds

- A review-command spec (rec. 1, 5), which should cite § 3.2, § 3.4, and the Codex and
  Antigravity notes together.
- A goal and continuation spec (rec. 2), which should cite § 3.3 and
  `docs/specs/2026-09-01-configured-verification-and-formatting.md`.
- Changes and agents views (rec. 3, 4), cosmetic over existing evidence and run records.

## Deletion inventory

Nothing. This is a research note; it makes no code or document obsolete.
