# Research: Codex CLI compared with Apex Code, September 2026

**Date:** 2026-09-23  
**Status:** Complete  
**Scope:** Current Codex CLI product and developer surfaces, compared with Apex Code's documented architecture and CLI.

## Executive summary

Codex CLI's recent strength is the way it joins familiar agent capabilities into a
coherent developer workflow: resume a thread, attach visual context, ask for focused
parallel work, review a diff, connect external tools, and reuse the same agent through
automation or a custom client.

Apex Code already has much of the underlying harness machinery: resumable tree sessions,
image-capable RPC, MCP, skills, hooks, bounded child sessions, structured JSON/RPC/ACP
interfaces, evidence, and provider choice across 35 providers. The opportunity is less
“add Codex's core” and more “make Apex's existing power easier to invoke and integrate.”

The strongest product lesson is a read-only review workflow that turns findings into the
next actionable step. The strongest platform lesson is to make automation a first-class
interface with explicit outcomes, stable events, and a supported client API. Apex has
already added a final result/status envelope to JSON mode; `--output-schema` remains a
separate possible follow-up. The strongest UX lesson is discoverability: Codex makes
resume, review, permissions, delegation, image input, web search, MCP, and cloud handoff
visible from its terminal workflow.

## Sources and comparison method

Codex observations come from official OpenAI documentation retrieved 2026-09-23:

- [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)
- [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra), published 2026-09-11

Apex observations come from this repository's `docs/roadmap.md`, `docs/user-guide.md`,
`packages/coding-agent/docs/json.md`, `packages/coding-agent/docs/rpc.md`, the package
exports, and the linked specs below. This is a product-surface comparison, not a claim
that the products target the same providers, service model, or user base.

## What Codex does well, and what Apex already has

| Codex workflow | Apex Code today | What is transferable |
| --- | --- | --- |
| Resume a thread, bring image context, use web search, delegate, review, connect MCP, and hand work to Codex cloud from the terminal | Session resume and branching; multimodal inputs through the harness/RPC; configured web search and native MCP; bounded child sessions; JSON, RPC, and ACP modes | Make common paths easy to find from `--help`, startup hints, and focused commands. Codex's cloud handoff itself is a hosted-product dependency, not a core harness feature. |
| Run `codex exec` in scripts; separate progress from final output; stream JSONL lifecycle events; accept piped context; optionally emit schema-constrained JSON | Print/text and JSON modes, JSONL RPC, session events, and a new JSON `result` event with an explicit status and meaningful exit code | Keep result semantics separate from event history, preserve clean stdout for pipelines, document status and failure behavior, and consider schema-constrained final output when there is a concrete consumer. |
| Use a TypeScript SDK to start, continue, and resume local threads; use App Server for clients that need auth, history, approvals, and streamed events | Public package exports include the main API, an RPC entry point, and a client; RPC already carries commands, events, UI requests, and image inputs | Treat Apex's API and RPC as supported product interfaces: version their wire shapes, keep examples current, and clarify which surface is intended for embedding versus scripting. A new protocol is not needed just to match names. |
| Delegate read-heavy exploration, tests, triage, and review to focused subagents; return summaries instead of raw work | Delegation has linked child sessions, configured agents, budgets, lifecycle operations, and persisted evidence | Carry over the context-management pattern: keep parent attention on decisions and synthesize concise child results. Preserve Apex's authority ceilings, bounded budgets, path ownership, and provider neutrality. |
| Bundle skills, MCP configuration, hooks, optional UI, and distribution in plugins | Apex has skills, MCP, extensions, package resources, and declarative hooks as distinct existing surfaces | Consider a unified, installable bundle only if users need a simpler distribution story. The architectural principle is composability and a small starting shape, not reproducing Codex's plugin directory or UI. |
| Use hooks at named lifecycle points, including permission requests and post-tool-use | Apex already has declarative hooks and a more general extension lifecycle | Improve hook visibility, validation, diagnostics, and documentation before adding event types. Keep trust and permission decisions in their existing owners. |

## Highest-value lesson: a review loop

Codex's dedicated review workflow can examine uncommitted changes, a commit, or a base
branch and report prioritized findings without changing the working tree. That is a
valuable terminal action because it has a clear read-only contract and naturally follows
implementation.

Apex's September 22 Antigravity comparison independently identified the same opportunity:
review a batch of changes, attach comments to specific lines, and feed those comments back
into the next agent turn. That comparison also records why persistent review comments need
a durable home if they must survive resume, fork, export, and delegation. See
[`2026-09-22-antigravity-cli-comparison.md`](2026-09-22-antigravity-cli-comparison.md), § 5.

Suggested Apex direction:

1. Start with a read-only command over the working diff, a commit, or a chosen base.
2. Report prioritized findings with file and line references and a short reason.
3. Offer a compact way to turn selected findings into the next prompt.
4. Only then decide whether review comments need session persistence or a richer TUI.

This should consume the existing permission and evidence models. It should not create a
second change classifier or silently mutate files during a review.

## Automation and embedding: match the contracts, not the branding

Codex's automation split is useful: `codex exec` is a straightforward scripting surface;
the SDK runs local threads programmatically; App Server serves richer clients needing
streamed events, approvals, and conversation control. Official docs now direct new
automation away from the deprecated `codex mcp-server` interface.

Apex already has three plausible equivalents: print/JSON for one-shot jobs, RPC for a
long-running process with interactive control, and a package API for applications.
Recent work closes an important gap: JSON mode now writes a terminal `result` envelope
with status and uses a failing exit code for failed runs. See
[`packages/coding-agent/docs/json.md`](../../packages/coding-agent/docs/json.md) and
[`2026-09-22-print-mode-exit-codes.md`](../specs/2026-09-22-print-mode-exit-codes.md).

The remaining work is contract clarity and ergonomics, not automatically a new SDK:

- State which interface is stable for shell scripts, interactive clients, and library
  embedding.
- Keep a minimal client example for each interface and make event/error semantics explicit.
- Consider a `--json-schema`/schema-constrained final result only when downstream users
  need it; keep it separate from the already-landed status-envelope fix.
- Preserve Apex's explicit permission-mode requirement for non-interactive runs. Codex's
  default read-only automation mode is a useful safety default, but Apex should compare
  that against its current fail-fast policy deliberately rather than silently changing it.

## Other lessons

### Make capabilities discoverable

Codex puts `/review`, `/permissions`, `codex resume`, image input, `--search`, `codex mcp`,
and completion directly in its CLI entry experience. Apex's docs already describe rich
capabilities, but the comparison suggests auditing first-run hints and command discovery
against what users actually need most often. High-value candidates are review, permission
inspection, session search/resume, and child-run status.

This should remain a presentation task where the underlying mechanism exists. A UI panel
is not evidence that a missing state contract has been designed.

### Keep agent instructions lean and task-specific

OpenAI's September 11 guidance says accumulated skills, project instructions, and prompts
can crowd context, and recommends revisiting their length and overlap. Apex already treats
prompt tokens as a budget and has progressive skill disclosure. The useful action is to
measure redundant guidance and description truncation, while retaining legal, safety, and
compatibility rules whose cost is justified by their consequences.

### Keep the comparative edge

Codex's surfaces are closely integrated with its own provider, cloud, and account model.
Apex's differentiation is provider neutrality, local-first operation, transparent
permissions, durable tree sessions, evidence capture, bounded delegation, and the ability
to embed without adopting one vendor's agent runtime. Reuse behavioral lessons while
keeping those boundaries intact.

## Recommendations, ranked

| Rank | Recommendation | Why |
| --- | --- | --- |
| 1 | Design a focused, read-only `/review` or `review` command, initially with findings that can be sent back as the next turn | High user value; clear contract; also supported by the recent Antigravity comparison. Decide persistence before promising line-comment continuity. |
| 2 | Document and stabilize the existing JSON, RPC, and package API contracts | Codex shows how powerful a clear split between scripts and rich clients is. Apex already has the primitives, so clarify guarantees before adding another layer. |
| 3 | Improve discoverability for existing skills, hooks, MCP, sessions, and child runs | Mostly reversible UX work over shipped mechanisms; lowers the gap between capability and perceived capability. |
| 4 | Consider schema-constrained final output as a follow-up to the result envelope | Helpful for CI and downstream tools, but the event stream and status contract should remain independently useful. |
| 5 | Explore a unified extension bundle only if install friction is demonstrated | Could make Apex's existing skill/MCP/hook pieces easier to share; adds lifecycle, trust, and compatibility surface. |

Do not prioritize cloud handoff, vendor-specific billing surfaces, or a full plugin UI
because Codex has them. Those features rely on Codex's hosted product model and do not
address Apex's strongest opportunities.

## Related Apex records

- [`docs/roadmap.md`](../roadmap.md) — phase and follow-up status.
- [`2026-09-09-run-and-child-session-architecture.md`](../specs/2026-09-09-run-and-child-session-architecture.md) — Codex's unified thread lifecycle as architectural input for Apex runs and child sessions.
- [`2026-08-31-declarative-hooks.md`](../specs/2026-08-31-declarative-hooks.md) — Apex's hook model.
- [`2026-08-28-native-mcp.md`](../specs/2026-08-28-native-mcp.md) — Apex's contract-aware MCP integration.
- [`2026-09-22-print-mode-exit-codes.md`](../specs/2026-09-22-print-mode-exit-codes.md) — JSON mode outcome contract.
- [`2026-09-22-antigravity-cli-comparison.md`](2026-09-22-antigravity-cli-comparison.md) — review-loop and structured-output design input.
