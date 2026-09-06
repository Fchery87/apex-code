# Security remediation implementation handoff

This is a handoff snapshot, not a progress board. Read the live task tables in the five plans before starting work. Keep task state and verified commit SHAs there. Keep phase state in the roadmap. Do not maintain a second checklist here.

## Start here

1. Read `AGENTS.md`, `CONTEXT.md`, and the documents linked below.
2. Run `git status --short`, `git branch --show-current`, and `git log -1 --format="%H %s"`.
3. Preserve unrelated changes. Do not reset, clean, rebase, or switch branches over uncommitted work.
4. Compare the affected source with the audited checkout before trusting historical probe output. Inspect each probe for side effects before running it.
5. Resolve the entry decisions below. Then start ST.1 with a failing public CLI test. Do not start all five implementation owners at once.

Writing this handoff does not start implementation or authorize publication, deployment, force-push, or deletion of user data.

## Read the design and evidence

- [Umbrella spec](../../docs/specs/2026-09-05-security-boundary-remediation.md).
- [Permanent audit review](../../docs/research/2026-09-05-apex-code-audit-review-and-architecture-critique.md).
- [Roadmap](../../docs/roadmap.md).
- [Original audit](../audit-2026-09-03/report.md).
- [Permission review](permissions-review.md).
- [Sandbox review](sandbox-review.md).
- [Execution and release review](execution-release-review.md).
- [Architecture critique](architecture-critique.md).
- [Market research](market-review.md).

The original audit checkout was `2477e594ef1479d1cb4467f0bc50c2e14fcd3e00`. The follow-up review used `1964612833cddbf89e4ad61fa0921e8b42f488cc`.

At handoff creation, the branch is `main` at `7a03b6a1d3b82f526ac2bca1e9a3b0f82d87d20e`. The working tree includes a modified roadmap and untracked remediation plans, spec, research note, and audit directories. No remediation implementation has been recorded in the plan tables. These are observations of this checkout, not a promise about the next checkout.

The original single `security-boundary-remediation` plan was replaced by the five plans below. Use their ST, CA, PS, PB, and RI identifiers. Do not resume from the retired SB identifiers in earlier chat replies.

## Follow the recommended order

For one implementer, finish each row before starting the next. Each plan contains multiple small changes, not a requirement to make one large commit.

| Order | Plan and task order | Why it comes here | Required result before advancing |
|---|---|---|---|
| 1 | [Startup and trust](../../docs/plans/2026-09-05-plan-startup-and-trust.md), ST.1 through ST.4 | These decide whether containment and authorization run at all. | Metadata-looking values cannot skip sandbox startup. Untrusted project MCP and grants remain inactive. Child writes cannot increase authority. |
| 2 | [Canonical authorization](../../docs/plans/2026-09-05-plan-canonical-authorization.md), CA.1 through CA.5 | Matching and execution must agree before more callers reuse the gate. | Canonical path targets, exact approvals, deny semantics, and tool mediation pass gate-then-execute checks. |
| 3 | [Policy and supervisor](../../docs/plans/2026-09-05-plan-policy-and-supervisor.md), PS.1 through PS.5 | Configured commands need the corrected gate. Host services need a clear authority split. | Deny spawns nothing, formatter writes stay in scope, supervisor state resists symlinks, and credential identity cannot change after approval. |
| 4 | [Platform boundaries](../../docs/plans/2026-09-05-plan-platform-boundaries.md), PB.1 through PB.5 | Private supervisor state supports platform profiles and minimal escalation runners. | Linux escalation works through the real child. Native macOS checks prove profile ownership and channel limits. Directory siblings stay unavailable. |
| 5 | [Release integrity](../../docs/plans/2026-09-05-plan-release-integrity.md), RI.1 through RI.5 | The final distribution must contain the verified repair and preserve tested artifact identity. | The exact tested bytes are the publish input. Digest and signed provenance checks pass. Only one release authority remains. |

### Parallel work

The runtime dependency chain is ST → CA → PS → PB. The release plan currently depends on ST. After ST passes, a separate release owner may implement RI in an isolated branch or worktree while the runtime owner proceeds with CA. This is an implementation opportunity, not permission to publish early.

Keep writes to the permission gate, SDK, canonical operation contracts, and supervisor launch files under one owner at a time. Do not parallelize PS and PB while their shared state interface is changing. Native Linux and macOS validation can run independently once the implementation head is fixed.

If the order must change, update the owning plan's task table and its Order changes section first. Keep task identifiers stable. Do not use this handoff to silently override plan dependencies.

## Resolve the entry decisions

The umbrella spec is Draft. The plans are Not started. Review the following before marking the spec Active and the first plan In progress.

1. Expand each task's file scope and exact test command before its first implementation edit. Current plan phrases such as "focused CLI suite" are not executable commands.
2. Name the data shape for the task. The umbrella operation model is a design direction, not a settled TypeScript API. Avoid forcing unrelated operations into one universal object if small typed boundary values preserve the same invariant.
3. Resolve the overlap between ST.3 and PS.3. ST.3 must actually prevent authorization self-modification before ST closes. It must not wait for PS.3. PS.3 can extend that ownership model to handoff state and host policy projection without creating a temporary competing store.
4. Treat formatter confinement as an open mechanism choice. A Git worktree alone is not confinement. Use a scratch probe to choose OS-enforced write restrictions or an isolated copy with restricted promotion. Post-hoc failure reporting alone cannot undo external side effects.
5. Review SDK compatibility before settling a new required option. The proposed `required`, `external`, and `none` values are not implemented. SDK absence of a supervisor is not itself an OS escape.
6. Preserve existing managed deny and plan-mode ceilings. Trusting project configuration must not allow it to widen a stronger authority.
7. Build regression coverage during every task. ST.4 consolidates the startup coverage. It is not permission to postpone tests until the end.
8. Clarify final scope. Unix-socket reachability is a documented limit, not a repaired guarantee. Broader audit hypotheses and market suggestions are not all implementation tasks in these five plans. Record an explicit disposition in the spec for anything left outside the repair scope rather than claiming the entire audit is closed.

## Run the first unit

Start at `packages/coding-agent/src/cli.ts`, `packages/coding-agent/src/cli/args.ts`, and `packages/coding-agent/src/core/sandbox/cli-launch.ts`.

Create a scratch workspace with harmless sentinel files. Use synthetic providers and credentials. Do not run the historical provider-backed CLI probe with real credentials.

Write a public launcher regression for metadata-looking option values and text after `--`. Observe the failure before editing the launcher. Add positive controls for genuine `--help` and `--version`. Check that an ordinary session selects the OS backend, not merely that a helper returns a Boolean.

Retain the command, source commit, stdout, stderr, exit status, platform, and sentinel assertions under `.apex-code/`. A later invalid-provider error is not sufficient proof of containment. Assert the intended child boundary directly.

## Verify each completed implementation slice

Run the narrow test file first. The repository's coding-agent test interface is:

```text
npm --prefix packages/coding-agent test -- <test-file>
```

Replace `<test-file>` with the existing or newly created test file for the task. Do not paste the placeholder as a claimed completed check.

Run these gates as required by `AGENTS.md`:

```text
npx tsgo --noEmit
npm test
npm run check
node scripts/validate-docs-lifecycle.mjs .
```

Run `npx tsgo --noEmit` regularly while editing TypeScript. Run `npm test` at the end of each completed implementation slice, not only after all five plans. Use public entrypoint tests in addition to unit tests. Measure relevant startup latency, command overhead, resource limits, and cleanup behavior against the same base before changing them. Record a justified regression threshold before judging a performance result. No performance baseline was established by this handoff.

Keep logs out of the task-table cells. Link to artifacts and record the exact checked commit. Verify every recorded SHA with `git cat-file -t <sha>`. Do not invent a SHA for an uncommitted task. Respect the repository's same-commit progress rule and resolve commit-recording mechanics explicitly rather than treating a proposed commit subject as evidence.

The audit's full test run failed with two startup-session failures. The isolated rerun passed. That is historical evidence, not today's baseline and not a green full suite. If the current branch is red, isolate the failing seam and repair or explicitly block on it before expanding the work.

## Keep the safety limits visible

- Never read, search, or copy the prohibited `c-code` tree. Use the existing research descriptions only.
- Do not fork or patch `pi-ai` or `pi-tui`. Preserve the fork boundary and upstream merge discipline.
- Do not create a second tool capability classifier. `buildToolContractSnapshot()` remains the describing projection, not a new authorization engine.
- A read-only root bind does not prove Unix-domain socket isolation or read confidentiality. Do not broaden the documented network guarantee by inference.
- macOS profile and escalation findings remain static until native tests run. A Linux test cannot close them.
- Do not disable repository-discovery controls so Git credential lookups can use repository helpers. Host helpers must come from trusted host configuration only.
- Do not claim a formatter is confined because it reports undeclared writes afterward.
- Do not claim provenance is verified because registry JSON contains a provenance field. Verify the signature, subject digest, and expected workflow identity.
- Do not use live credentials, publish packages, deploy, or force-push as part of a scratch regression test.

## Stop or narrow the task when evidence is missing

Stop the affected task when its public path cannot be reproduced safely, a required native platform is unavailable, or a design cannot enforce the stated invariant. Record what evidence is missing in the owning plan. Continue only independent work whose prerequisites are satisfied.

Stop and report if a committed credential is discovered. Treat it as leaked. Never copy the credential into a report.

Do not mark all remediation complete just because document lifecycle validation passes. Closure requires current runtime evidence and release artifact evidence for the promised guarantees.

## Close the work without another status board

Update each plan's task table as its work is verified. Before deleting a completed plan, promote durable decisions into the spec or an ADR, verify the task SHAs, and remove its live links from the spec and roadmap. Delete this handoff or refresh its reading links when the referenced plans are removed. It is not a permanent architectural decision.

Only mark the umbrella work landed after the final integrated head passes the promised checks and every excluded finding has a documented disposition. Creating this note made no commits, source edits, PRs, or releases.
