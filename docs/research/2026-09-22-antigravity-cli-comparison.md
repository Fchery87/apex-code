# Research: Antigravity CLI compared with Apex Code, September 2026

**Date:** 2026-09-22 · **Status:** Permanent — source of record for the non-interactive
exit contract and the review-loop design inputs

> **Provenance.** External observations below are behavioral descriptions read from
> Google's public Antigravity CLI documentation at `https://antigravity.google/docs/cli/`,
> retrieved 2026-09-21, cited by page path. No unlicensed source is involved and none was
> opened (ADR 0002). Apex-side claims were measured directly from this tree at `9a62c26d1`
> (version 0.4.0) by reading source and by running the built binary's `--help`; each one
> cites `file:line`. Two independent model critiques were commissioned against these
> inventories; where a critique's claim failed verification it is recorded in § 7 rather
> than dropped, because the failure is itself the useful record.

## 1. Why this exists

Antigravity CLI is the first terminal agent from a major vendor whose documented feature
set overlaps Apex Code's across the whole product, not just the loop. It is therefore the
cleanest external yardstick available for two questions the roadmap does not currently
answer: which of Apex Code's remaining gaps are contracts that get more expensive every
release, and which are panels that can be drawn whenever.

The audit found one defect, not a gap. It is recorded in § 4 and specified in
`docs/specs/2026-09-22-print-mode-exit-codes.md`. Everything else here is design input.

## 2. What Antigravity CLI is

Binary `agy`. Proprietary. Configuration at `~/.gemini/antigravity-cli/settings.json`,
keybindings at `keybindings.json` beside it, skills at `.agents/skills/`, agent definitions
at `.agents/agents/<name>.md`, MCP at `.agents/mcp_config.json`.

Authentication is a Google account stored in the OS keyring, or `GEMINI_API_KEY` with
`modelProvider: "gemini"`. `GOOGLE_API_KEY` has no effect and a `.env` file is not read.
`agy models` lists the `gemini-3.x` family plus `claude-sonnet-4-6`, the latter served
through Google. There is no bring-your-own-provider path.

Three execution modes exist, cycled with `Shift+Tab`. `default` pauses for diff review
before writes, `accept-edits` auto-approves file mutations, `plan` restricts to read-only
tools. The `sandbox` setting is deliberately outside this cycle and the docs call
conflating them a common mistake.

## 3. Where Apex Code leads

Measured, not asserted. Each row names the mechanism rather than the intent.

| Area | Apex Code | Antigravity CLI |
| --- | --- | --- |
| Providers | 35 across 9 API dialects (`CONTEXT.md`) | Google-served only |
| Shell permission grammar | `bash` splits on shell operators, every segment must match an allow rule, unparseable constructs resolve to `ask`, adversarial bypass corpus ships with the grammar (ADR 0004) | `command(regex:…)` matched against a command string, no documented decomposition |
| Rule precedence | Eight sources, highest match wins regardless of behavior, so a broad organizational deny stays narrowable (ADR 0004) | allow/deny/ask lists over three scopes, no stated conflict rule |
| MCP rule grammar | Server position is never wildcardable, `Mcp(*:*)` is rejected rather than read as "all MCP" (ADR 0025) | not documented |
| Non-interactive safety | A session with no explicit `--permission-mode` exits at startup naming the valid modes; `ask` fails closed (ADR 0004) | Unapprovable calls soft-deny, the run continues and exits 0 with a stderr notice (`/docs/cli/headless/`) |
| Delegation containment | `computeCapabilityCeiling()` admits the child's requested set only when the parent's expanded set covers it, and refuses rather than narrowing (`core/delegation/ceiling.ts:32`); depth 2; aggregate budgets, concurrency caps, idempotent spawn, token and cost rollups (ADR 0008) | depth cap 10, inherited command prefixes and directory scopes, no documented capability subset check, no token or cost caps |
| Evidence | Tools record facts they observed directly; large payloads land in a content-addressed sha256-verified store, policy is a separate non-authorizing consumer (ADR 0007) | no equivalent |
| Sessions | JSONL entries linked `id`/`parentId` into a tree, branching in place, `/tree` navigation with branch summarization, git checkpoints on by default | `/fork` clones a thread |
| Editor integration | `--mode acp` is a real Agent Client Protocol v1 server (`modes/acp/server.ts`), reaching Zed and the JetBrains IDEs | none; Antigravity ships its own IDE |
| Context engineering | Compaction, in-place tool-result eviction, deferred tool schemas, all measured against the replay corpus | not documented |
| Skill catalog cost | Names only inside a 2,500-token budget against a measured 2,372-token floor, descriptions resolved through `skill_search` (ADR 0021) | `/skills` browser, no stated budget |
| Telemetry | No project-directed telemetry exists (ADR 0009) | `enableTelemetry` defaults to `true` |

Two of these are structural rather than merely current. Provider independence cannot be
closed by Google without removing the reason Antigravity exists as a distribution channel,
and the MIT license cannot be matched by a proprietary product. The permission grammar and
the capability ceiling are ordinary engineering leads, defensible only while Google keeps a
string matcher and an unbounded delegation depth.

## 4. The defect

`packages/coding-agent/src/modes/print-mode.ts` initialises `exitCode` to `0` at line 36.
The only assignments to `1` are at lines 154 and 163, and both sit inside
`if (mode === "text")` at line 147. In `--mode json` a provider error, an aborted turn, and
an exhausted run budget therefore all exit `0`. Only a thrown exception reaches the catch at
line 174.

`README.md:480` recommends exactly this invocation for automation, under the line "Use
JSON/RPC when another process owns orchestration". A caller that owns orchestration cannot
distinguish a failed run from a successful one.

The path is untested. `test/print-mode.test.ts:126` covers the `error` stop reason and
`:143` covers budget exhaustion; both pass `mode: "text"`. The JSON case at `:111` asserts
only that the happy path returns `0`.

This is the same class of hazard as Antigravity's documented soft-deny, arrived at by
accident rather than by decision, and covering real errors rather than only denials.
Specified in `docs/specs/2026-09-22-print-mode-exit-codes.md`.

## 5. Gaps worth closing, and the test that sorts them

A gap is **architectural** when its absence makes a caller build a workaround that then
becomes a compatibility obligation. It is **cosmetic** when closing it is purely additive
and nothing has encoded a dependency on the absence.

The test is not how much code the gap costs. `--mode json`'s result shape is architectural
despite being small, because the first CI pipeline that parses it freezes it. A permissions
inspector is cosmetic despite being large, because nothing depends on a panel that does not
exist. Ranking by effort inverts this and ships the permanent decisions carelessly while
deferring the reversible ones.

### Architectural

| Gap | Why it cannot wait | Effort |
| --- | --- | --- |
| Result envelope with a status enum and an exit-code taxonomy | A stream of session deltas is not a result. Callers branch on exit codes, and the enum is defined once for free. | S–M |
| Persistence shape for line-anchored review comments | Comments keyed by file, line, and turn need a home in the session tree or the evidence ledger. Held in TUI state they die on `--resume`, `/fork`, `/export`, and delegation. | M |
| A `CredentialStore` seam | Credentials are plaintext at `~/.apex-code/agent/auth.json` mode 0600 (`core/auth-storage.ts:25`), with no keyring. Once extensions and MCP servers read that path, the path is the contract. Introduce the interface now, choose a backend later. | M |
| Delegation telemetry as a subscribable stream | A future monitoring panel must read what the run budgets already track, or it becomes a second classification of the kind ADR 0010 exists to prevent. | S |
| `--json-schema` structured output | Folds into the result envelope as a parameter. Decide alongside it, not after. | S |

### Cosmetic

A `/permissions` inspector is the highest-value entry and the sharpest irony in the audit.
Apex Code has the strongest permission model in the comparison and the weakest way to see
it: eight precedence levels and four file scopes, resolved only by hand-editing JSON.
`buildToolContractSnapshot()` already exists, so this is a resolver trace plus a panel.

A `/context` view is the cheapest. Every number it would show is already measured.

Then the aggregate `/diff` viewer, which pairs with the review-comment model above and
should follow it. Then `/skills` and `/hooks` browsers, a configurable terminal title, and
`--print-timeout`.

An `/agents` monitoring panel ranks lower than its prominence suggests. Antigravity needs
one because its delegation runs to depth 10 with no documented budget; Apex Code's is
bounded by design and `apex-code agent list|wait|send` already covers the bounded case.

### The idea worth taking

Antigravity's artifact review loop, minus its chrome. The load-bearing part is reviewing a
batch of changes at a milestone, commenting on specific lines, and having those comments
become the next turn. `plan_present` already exists for exactly the reason this needs,
described in its own source as closing the gap where "plan mode can deny mutation but had
no tool to leave it through". Extending it from one markdown plan to a multi-file batch with
line comments does not weaken the per-call gate, which keeps running underneath.

The Mermaid rendering with Kitty Graphics, ASCII fallback, and zoom is a demonstration.
Build the loop, skip the renderer.

## 6. Declined

Recorded so the question is not reopened without new information. Two independent critiques
agreed on this list, which is the strongest signal in the audit.

- **Scriptable statusline.** Running a user script on every agent state change is an
  untrusted subprocess per frame, and its JSON payload becomes a frozen public contract
  containing concepts Apex Code does not have, such as quota and plan tier. The footer is
  already replaceable by extension code through `ctx.ui.setFooter`. Add format tokens if
  configurability is wanted.
- **In-prompt vim mode.** A modal editor is an unbounded surface of registers, counts,
  macros, and ex commands. The bounded answer, `ctrl+g` into `$EDITOR`, already ships
  (`modes/interactive/external-editor.ts:61`). Building it inside the prompt would also
  pressure the `pi-tui` boundary ADR 0001 defends.
- **Voice dictation.** An audio daemon, three OS audio stacks, and an SSH transport
  variable, for a tool whose value is composing over stdin and stdout.
- **`/codesearch`.** Apex Code ships `grep` and `find` as model-callable tools. A
  full-screen human regex browser serves a harness where the human searches. The part worth
  taking is line comments flowing back to the agent, which belongs to the review loop above.
- **A built-in OS sandbox.** Removed deliberately by ADR 0032. A competitor shipping one is
  not new information.
- **`/add-dir`.** `--add-dir` was deleted by ADR 0032 because it means nothing once the
  write boundary is gone. Re-adding it would ship a security-shaped word with no boundary
  behind it.
- **`/credits`, `/boost`, `/usage`, `/teamwork-preview`, `/remote-control`, `/feedback`.**
  Billing and growth surfaces for a single-vendor metered product. Counting them inflates
  the slash-command comparison from roughly 27 against 28 to 27 against 35.

## 7. Claims that failed verification

A commissioned critique reported, as its sharpest finding, that ADR 0001's fork boundary is
fictional, citing `packages/ai` at 335 tracked files, `packages/tui` at 94, symlinks from
`node_modules/@earendil-works/*` into the tree, an apex-authored commit `817b647ef` patching
`packages/ai`, and a shrinkwrap resolving `pi-ai` from `registry.npmjs.org`.

Every cited fact is true and the conclusion does not follow. The critique read ADR 0001's
decision and stopped before its two amendments.

- The 2026-08-09 amendment decides the full-tree graft on purpose, having rejected deleting
  the consumed packages because that "would manufacture a conflict on every upstream change
  to those paths, permanently". The packages are present and frozen, and published artifacts
  depend on the npm releases. The shrinkwrap resolving from the registry is the design
  working, not evidence against it.
- The freeze is enforced. `.github/workflows/ci.yml:28` defines a `frozen-packages` job that
  runs first and standalone, with `fetch-depth: 0`, executing
  `scripts/apex/check-frozen-packages.mjs`.
- The 2026-08-26 amendment covers `817b647ef`, whose own message says "backport". The
  mechanism requires every line in `.upstream-backports` to be a 40-character sha reachable
  from `upstream/main`, with the diff read from upstream's history at gate time, so nothing
  hand-written is trusted. That file currently holds only its header comment against
  `.upstream-tag` at `v0.84.4`, which is the retirement the amendment requires, performed.

Recorded because the finding was specific and confident, and acting on it would have meant
amending an ADR that is already correct. Two corrections the same critique raised did hold
and are carried into § 8.

## 8. Corrections to Apex Code's own descriptions

- `cli/args.ts:424` describes `--mode` as "text (default), json, or rpc". The parser at
  `:208` accepts `acp`. The ACP adapter is how Apex Code reaches editors, and it is absent
  from the CLI's own help.
- "No telemetry" understates what ADR 0009 actually establishes and overstates what ships.
  `sendProviderAttribution` defaults to `true` and attaches identifying headers to requests
  already bound for the configured provider, and ADR 0012 defines an OTLP export to a
  user-named collector. The accurate claim is no **project-directed** telemetry, which is
  what ADR 0009 says.
- The provider count is 35 over 9 API dialects per `CONTEXT.md`, not the ~28 obtainable by
  counting environment variables in the help text.
- Apex Code does set the terminal title, through OSC 0 at `packages/tui/src/terminal.ts:526`
  called from `modes/interactive/interactive-mode.ts:1211` with a fixed format. The gap is
  configurability, not absence.
- `web_search` hardcodes `https://api.exa.ai/search` at `core/tools/web-search-exa.ts:4`,
  but `core/settings-manager.ts:188` leaves the tool "registered but unconfigured" until a
  user supplies a key. ADR 0013 holds; there is no unowned hosted-service default.

## 9. What this feeds

- `docs/specs/2026-09-22-print-mode-exit-codes.md` acts on § 4 and the first architectural
  row of § 5.
- The remaining architectural rows in § 5 need specs before implementation, written when
  this one exits.
- § 6 is the record for declining these features. Reopening any of them needs new
  information, not a new competitor release.
