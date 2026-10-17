# RS.8 / RS.9 arena cross-judge

Read both candidates in full, the subsystem trace, and the architect red-flag checklist. Spot-checked SDK default selection, session runtime defaults/loadout application, settlement, branch traversal, extension-widget replacement, and settings precedence. Read-only design review; no tests run. The prescribed external models are unavailable, so this judge uses the supported inherited model.

| Criterion (0–5) | A | B | Assessment |
| --- | ---: | ---: | --- |
| Branch/compaction/resume; no new storage or model context | 5 | 4 | A's live identity/session/leaf cache follows the authoritative unabridged branch without requiring exhaustive notification producers. B is sound if every proposed mutation producer is implemented correctly. |
| Independent core widget and lifecycle | 5 | 4 | Both isolate core ownership from extension replacement. A concentrates policy in one component; B adds controller binding and subscription cleanup. |
| Small API; no per-frame scans; actual tool gating | 5 | 2 | A scans on leaf changes and gates actual active names each frame. B adds manager observers and two public events solely for immediate idle redraw, which is outside the agreed requirement. |
| Bounded safe rendering, errors, disclosure | 5 | 5 | Both normalize imported data, cap terminal lines, and require actual tool-cell error/disclosure checks. |
| Opt-in/default preservation; future-only settings clarity | 4 | 4 | Both distinguish implicit configured defaults from live CLI/hook selection. Both currently suggest captured defaults plus session fallback, which needs the revision below. |
| Meaningful public tests and mounted performance | 5 | 5 | Both require mounted dock/panel measurements and real session/settings/component boundaries; neither claims unrun verification. |
| **Total** | **29/30** | **24/30** | **Use A with the two revisions below.** |

## Decision and grafts

Choose A. Next-requested-frame visibility for idle SDK loadout/branch changes is an honest accepted contract. Do not add manager observers, session event variants, a polling loop, or an active-tools notification. Core composition and the standalone panel keep this feature out of storage/session synchronization infrastructure.

1. Adopt B's explicit project-override treatment: when project `defaultTools` shadows user defaults, make the future-default control read-only with a clear explanation rather than report a successful effective toggle. Reuse the existing selector feedback seam; do not invent a settings-source protocol. Also preserve B's bind/replacement lifecycle test coverage, while using A's live session getter instead of subscription callbacks.
2. Use one internal configured-default helper while preserving existing caller semantics. SDK calls it with configured LSP/search/MCP and captures that original result in session config; low-level AgentSession calls it with its existing custom-base override or core-plus-LSP policy. The settings-facing getter returns a copy of the captured SDK result when supplied, otherwise the helper's low-level result. The optional captured config is justified provenance, not a second classification algorithm. Keep core names and service inclusion logic in the helper; do not duplicate either fallback list. Avoid importing SDK into AgentSession or creating a circular dependency. Explicit CLI/saved arrays/exclusions/noTools remain subsequent selection policy; the helper must not inspect current loadout or registered names. This is a policy module, not a pass-through wrapper.

## Load-bearing facts and remaining constraints

- `core/sdk.ts:440` currently computes core four plus configured LSP/search/MCP, before saved defaults and CLI/noTools/exclusion selection. `core/agent-session.ts:4531` separately computes custom base keys or core four plus LSP only. Preserve both caller semantics and test low-level construction explicitly. This slice does not justify silently activating configured search/MCP in low-level construction. Capturing SDK defaults therefore remains appropriate even with the shared helper.
- `getActiveToolNames()` reads actual `agent.state.tools`; `_applyRequestedTools()` has no event. A's next-frame gating claim matches the source. Branch traversal follows the full parent chain, and widget reconstruction clears its container, validating the cache source and separate core container.
- Settlement clears `_isAgentRunActive` and emits `agent_settled`; `isStreaming` already exposes that lifecycle fact. Use existing authority if a same-session mid-run UI rebind needs seeding, with a focused test; do not introduce another lifecycle getter. Track newly completed todo entry identity so starting a later run never resurrects an old completed list.
- A's leaf-key cache assumes append-only full task snapshots. Document this task-update contract and test direct appended replacement/empty snapshots. No deep fingerprint on every frame.

Red flags screened: reject B's broad storage notification surface and unnecessary temporal bind/unbind coordination; revise A's duplicated default policy. A's single panel owns validation/cache/gating/retention/rendering, and its caller owns placement and existing event forwarding. No wire-type export, executable tool import into display modules, or pi-tui patch is justified. Preserve actual tool-cell single-summary/error/disclosure assertions and production dock measurements; transcript-only benchmarks cannot prove this panel's cost.
