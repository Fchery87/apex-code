# Spec: Decisions settled after the harness review remediation

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | fchery87 (drafted with Claude) |
| Created | `2026-10-17` |
| Last updated | `2026-10-17` |
| Roadmap phase | none. A follow-up row in `docs/roadmap.md` |
| Tracking issue/PR | none yet |
| Compatibility posture | Preserves compatibility for the defaults. Two behaviors tighten, each with a setting that restores the old behavior. |

## Executive summary

Eight open questions from the merged remediation were settled. Three of them change code: a proxy opt-in for `web_fetch`, a capped output-limit floor for the compaction reserve, and a setting that turns off startup discovery of lazy MCP servers. The other five stay as they were, and the glossary gains four terms.

## Context and motivation

- `docs/specs/2026-10-16-harness-review-remediation.md`, which is Landed. Its "Decisions settled in review" table records the original answers.
- Market research on 2026-10-16. Claude Code requires a read before edit for older models and relaxes it for newer ones. Claude Code defers MCP tools by default. Codex caps auto-compaction at 90% of the window. The DNS-rebinding advisories in 2026 all come from checking a host and then connecting to it again.

## Current state

- `web_fetch` refused private addresses and pinned connections when no proxy was set. With a proxy set, it ran without pinning.
- The compaction reserve was `max(reserveTokens, model max output)`. A 128k-output model on a 200k window reserved 128k.
- Startup discovery started every lazy MCP server with no cache entry, with no way to turn it off.

## The problem

- A proxy-configured user could be exposed to DNS rebinding with no explicit choice.
- A large output limit could claim most of a small window, and compaction triggered too early.
- A user who did not want lazy servers started had no setting to stop it.

## Goals

- [x] With a proxy configured, `web_fetch` refuses unless `webFetch.allowProxiedFetch` is set in user settings.
- [x] The compaction reserve's output-limit floor is capped at `outputReserveFraction` of the window, defaulting to one third.
- [x] `mcpStartupDiscovery: false` stops startup discovery of lazy MCP servers. It defaults to on.
- [x] The glossary defines Read ledger, Foreground subagent, Environment block, and Plan-mode active set.

## Non-goals

- [x] `todo_write` and `ask_user` stay opt-in. The RS.9 task-list opt-in is deliberate, and `ask_user` needs a UI signal the session does not have at construction.
- [x] OpenCode Go stays on its previous model snapshot. Its refreshed data needs a Google-API provider in the frozen `packages/ai`.
- [x] The plugin API stays unpublished. Publishing needs a written stability policy first, and no market norm for one was found to copy.
- [x] `edit` keeps change detection only, with no required prior read. An exact, unique `oldText` match already limits blind edits.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| `web_fetch` | Refuse fetches when a proxy is configured, unless `allowProxiedFetch` is true | `tools/web-fetch.ts` |
| Settings | `webFetch.allowProxiedFetch` (user only); `mcpStartupDiscovery` (default on); `compaction.outputReserveFraction` | `settings-manager.ts` |
| Plumbing | `webFetchAllowProxiedFetch` through session config, SDK, and services | `agent-session.ts`, `sdk.ts`, `agent-session-services.ts` |
| Compaction | `effectiveReserveTokens(settings, maxOutput, contextWindow)` caps the floor at `contextWindow * fraction` | `compaction/compaction.ts`, `agent-session.ts` |
| MCP | `warm({ discoverLazy })` returns no lazy starts when false | `mcp/runtime.ts`, `sdk.ts` |
| Glossary | Four terms | `CONTEXT.md` |

**Seam check.** The proxy refusal happens before any request, so the permission gate and the pinned path are unchanged. The compaction change keeps `shouldCompact`'s signature, and only its reserve argument changes.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| The proxy-path behavior that let `web_fetch` run through a proxy with no opt-in | behavior | superseded by the refusal and the opt-in (Q4) |
| The uncapped output-limit floor in the compaction reserve | behavior | superseded by the capped floor (Q6) |
| Unconditional startup discovery of lazy MCP servers | behavior | superseded by `mcpStartupDiscovery`, default on (Q7) |

Nothing else is removed. The change is additive apart from those three behaviors.

## Risks

- A user behind a corporate proxy will find `web_fetch` refused until they set `allowProxiedFetch`. The error names the setting. A report of a refused fetch that the user expected to work is the signal.
- A capped reserve compacts later for large-output models than the uncapped floor did. That was the earlier, safer behavior for very small windows. The compaction characterization tests are the signal.

## Verification

- `test/tools/web-fetch-boundary.test.ts` and `test/tools/web-fetch-settings.test.ts`: refusal with a proxy, no network access when refused, opt-in proceeds, user-only setting.
- `test/compaction-reserve.test.ts`: the cap, the configured fraction, and the threshold on either side of the cap.
- `test/mcp/cold-discovery.test.ts` and `test/tools/web-fetch-settings.test.ts`: `discoverLazy: false` starts nothing, and the setting defaults on.
- Full `npm test` on the branch: 484 files and 4,426 tests pass, 51 skipped, exit 0 (run after the fixture fix, at `f9586cdf4`).
- Three-OS CI on [PR #176](https://github.com/Fchery87/apex-code/pull/176) at `f9586cdf4`: ubuntu, macOS and Windows pass, with CodeQL and the frozen-package check.

## Rollout

- Small enough to implement directly. The plan is not needed.
- No ADR. Each decision is reversible, and the glossary and this spec record them.
