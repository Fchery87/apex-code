# Market review: security and differentiation

**Retrieval date:** 2026-09-05 UTC. **Apex reference:** HEAD `1964612833cddbf89e4ad61fa0921e8b42f488cc`. This is desk research from public first-party documents, not a test of competing binaries. Vendor statements are labeled as claims. Apex behavior claims come from the 2026-09-03 audit reports and the current README, not from this market fetch.

## Executive view

Apex has a credible narrow position: a provider-independent local coding harness for teams that need a reviewable record of agent actions. Its strongest differentiator is the combination of a required tool contract, source-captured evidence, session trees, and an OS sandbox with explicit host escalation. The claim is not yet safe to market as a complete security boundary. The audit found trust-loader bypasses, permission/execution mismatches, policy-command bypasses, supervisor hazards, and release-integrity gaps. Fix those before making security the headline.

The market splits clearly. Claude Code and Codex have polished vendor-owned workflows and broad hosted ecosystems. Gemini CLI combines folder trust, hooks, MCP, sandboxing, and OpenTelemetry. OpenCode is provider-flexible and open source, but its own SECURITY.md says it has **no sandbox** and that permissions are a UX feature. Apex can win with evidence and policy portability, not with raw model choice or claimed isolation alone.

## Comparison

| Axis | Public evidence | Implication for Apex |
|---|---|---|
| Project trust | Gemini's trusted folders ask before project configuration loads, but the feature is disabled by default [G2]. Codex says project `.codex/` layers load only for trusted projects [O7]. Claude says noninteractive `-p` disables trust verification [C3]. OpenCode auto-loads project plugins from `.opencode/plugins/` [P5]. | Make trust default-on and apply it to every project loader: permissions, MCP, hooks, plugins, and skills. Test headless mode separately. The audit says Apex currently misses permissions and eager MCP. |
| Shell sandbox and fallback | Claude documents sandbox disabled by default and warns then runs unsandboxed when unavailable [C1]. Codex documents network off by default and OS isolation for local commands [O1]. Gemini documents sandboxing as an isolation barrier [G1]. OpenCode explicitly has no sandbox [P6]. | Apex's normal Linux/macOS sandbox and fail-closed startup are useful. Preserve that lead, but repair the audited raw-argument bypass and supervisor paths. Publish a support matrix and refusal tests. |
| MCP and hooks | Claude command hooks run with full user permissions and headless project MCP can load without asking [C2,C3]. Codex project MCP is trust-gated [O4,O7], and hook trust uses the current hook hash [O3]. Gemini hooks run synchronously and can validate or block actions [G4]; MCP exposes external tools [G5]. OpenCode local/remote MCP is automatically available and plugins load at startup [P4,P5]. | Apex should show trust state, source, identity/hash, capabilities, and evidence for each extension/MCP action. Do not imply MCP inherits shell controls unless it does. |
| Admin policy | Codex managed requirements constrain security-sensitive settings and require approved MCP name and identity [O2]. Claude documents managed settings and precedence, with list-merging caveats [C4]. | Add an immutable, centrally supplied policy snapshot and tests proving project files cannot broaden it. The audit found host policy lost at sandbox launch. |
| Provider independence | OpenCode claims 75+ providers and local models [P3]. Apex README says provider-agnostic and consumes Pi's provider layer [README, Models and providers]. Claude and Codex are vendor-centered products. | This is a real adoption reason for engineering teams avoiding one model vendor. Measure successful setup across providers, not provider count. |
| Audit/evidence | Gemini advertises OpenTelemetry logs, metrics, and traces [G6]. Apex README says Bash records actual argv/exit code and edits record patch information [README, Sessions, state, and evidence]. The reviewed vendor pages do not establish an equivalent portable, source-captured action ledger. | Make evidence exportable, scrubbed, hash-linked, and useful in CI. Demonstrate that the ledger records what executed, not just model text. |
| Adoption friction | Apex pre-alpha requires Node 22.19+, a provider account, and explicit provider setup [README, Install]. OpenCode offers a local/direct-provider trial and says it does not store code/context [P2]. Gemini and others have established CLI onboarding. | Start with teams already operating local agents and needing review evidence. Do not target casual individual users first. Provide one-command install, offline mode, policy templates, and a no-provider replay demo. |

## Provenance and trust signals

Apex README documents npm prerelease publishing and standalone GitHub archives with SHA-256 manifests, and says token-free trusted publishing was proven in the roadmap. Those are useful claims, but the September audit found the release workflow publishes again from package directories and verifies registry hashes rather than proving the tested bytes and signed attestation match. Treat release provenance as unfinished until the workflow publishes the exact tested tarballs and verifies attestation subject digest and identity.

Relevant public provenance documentation: npm, [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements) [N1], and [Trusted publishers](https://docs.npmjs.com/trusted-publishers) [N2]. GitHub's artifact-attestation documentation is [here](https://docs.github.com/en/actions/concepts/security/artifact-attestations) [H1]. These describe mechanisms, not proof that Apex's current release pipeline uses them correctly.

## Recommended target and position

Target security-conscious software teams running local or self-hosted coding agents across more than one model provider. The buyer is an engineering enablement or security lead who needs to answer: which agent ran what command, under which policy, with what result, and can we replay or inspect it later? Avoid claiming compliance or perfect containment.

A concise position: **"A provider-independent coding agent with a reviewable action ledger and enforceable local policy."** The proof must be an exported ledger and adversarial test report, not a feature list.

Smallest product package:

1. Trust-gate every project-owned loader, including MCP, hooks, permissions, skills, plugins, and policy.
2. Resolve one canonical operation before authorization and execution. Fail closed on parser ambiguity, unsupported rules, missing sandbox backends, and undeclared formatter writes.
3. Make policy immutable from the supervisor, and move supervisor state outside child-writable paths.
4. Publish exact tested artifacts with verifiable signed provenance.
5. Ship a scrubbed JSONL evidence export and a CI verifier. Include argv, canonical targets, policy decision, sandbox profile, escalation approvals, exit status, and patch hashes.

## Validation experiments

Run these with named baselines and publish results. Do not invent market size or adoption numbers.

- **Evidence usefulness:** give 8-12 target-team engineers the same 20-task corpus in Apex and their current tool. Measure time to reconstruct the actual command, changed path, policy decision, and result from the exported record. Success: at least 90% of tasks reconstructed without reading raw model transcript, with zero secret leakage in the scrubbed export.
- **Provider-switch friction:** new users configure two hosted providers and one local endpoint from a clean machine. Measure time-to-first successful read-only replay and failure reasons. Set the threshold after a pilot, then keep it fixed.
- **Trust adversarial suite:** repositories contain project permissions, MCP, hooks, plugins, symlinks, malformed rules, and option values resembling `--help`/`--version`. Run trusted and untrusted modes, interactive and headless. Success: no project code executes before trust, no denied canonical target executes, and unsupported sandbox startup refuses.
- **Policy portability:** encode one policy in Apex and compare decisions for read, write, shell, MCP, and formatter operations against a human-reviewed expected matrix. Track false allows, false denies, and time to review.
- **Release verification:** from a clean runner, verify the downloaded npm package and standalone archive against the exact locally tested digest and signed provenance subject. A release is not green when only the registry-reported hash matches.

## Evidence register

All fetched response bodies and extracted text are in `.apex-code/audit-review-2026-09-05/market-evidence/`, with metadata in `fetches.json`. Retrieval was by public HTTP GET; no credentials or vendor executable tests were used.

- [C1] https://code.claude.com/docs/en/sandboxing
- [C2] https://code.claude.com/docs/en/hooks
- [C3] https://code.claude.com/docs/en/mcp
- [C4] https://code.claude.com/docs/en/settings
- [G1] https://geminicli.com/docs/cli/sandbox/
- [G2] https://geminicli.com/docs/cli/trusted-folders/
- [G4] https://geminicli.com/docs/hooks/
- [G5] https://geminicli.com/docs/tools/mcp-server/
- [G6] https://geminicli.com/docs/cli/telemetry/
- [O1] https://developers.openai.com/codex/sandbox (redirected to https://learn.chatgpt.com/docs/agent-approvals-security)
- [O2] https://developers.openai.com/codex/enterprise/managed-configuration
- [O3] https://developers.openai.com/codex/hooks
- [O4] https://developers.openai.com/codex/mcp
- [O7] https://developers.openai.com/codex/config-file/config-basic
- [P2] https://opencode.ai/docs/enterprise/
- [P3] https://opencode.ai/docs/providers/
- [P4] https://opencode.ai/docs/mcp-servers/
- [P5] https://opencode.ai/docs/plugins/
- [P6] https://raw.githubusercontent.com/anomalyco/opencode/dev/SECURITY.md
- [N1] https://docs.npmjs.com/generating-provenance-statements
- [N2] https://docs.npmjs.com/trusted-publishers
- [H1] https://docs.github.com/en/actions/concepts/security/artifact-attestations

**Caveat:** these are current pages retrieved 2026-09-05. They do not prove competitor behavior on 2026-09-03, and documentation is not executable verification. The prior `public-comparison.md` contains date-pinned Claude changelog and January Codex history where available.
