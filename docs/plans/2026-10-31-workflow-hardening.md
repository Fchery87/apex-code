# Workflow hardening implementation plan

**Status:** Active. This reconstructed H1 branch disables executable workflows before rebuilding JSON interpretation in H2, bounded lifecycle in H3, and verification in H4. The prior combined implementation remains a recovery reference, not this branch's acceptance evidence. All phases remain open.

**Goal.** Make existing workflows safe to invoke and bounded before adding durable delivery automation.
**Architecture.** Replace JavaScript execution with validated data interpreted over the existing delegation runtime. Keep permission, child ownership, and session storage authoritative in their current modules.
**Tech stack.** TypeScript, Node, Vitest, existing tool contracts, and the current delegation registry.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. Check a box only when its evidence exists. Keep logs and media under `.apex-code/modernization/` by PR and head SHA.

H1 through H4 are dependency-ordered review slices within the single active workflow-hardening roadmap phase, not plans for future roadmap phases. The operator authorized reconstructing this existing implementation as one four-PR stack. No delivery or automation phase beyond workflow hardening is planned here.

Execute through `/home/nochaserz/.agents/skills/poteto-mode/playbooks/autopilot-stack.md`. The operator owns landing. The operator authorized implementation, commits, push, and review PR creation in this session on 2026-10-31. This supersedes the earlier planning-only restriction. Do not merge or enable auto-merge.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

The current slice implements [the draft spec](../specs/2026-10-31-workflow-hardening.md). Later stages remain roadmap candidates. Proposed new filenames below are design targets. Reconfirm call sites against the execution revision.

## Program checklist

### Arm the program

- [x] Confirm the proposed definition format and the legacy-JavaScript removal with the operator before implementation. Recorded in ADR 0039 under the operator's implementation grant.
- [x] Read AGENTS.md, CONTEXT.md, ADRs 0001, 0003, 0006, 0008, 0010, and 0032 from the execution base. Base rules and revisions are recorded under `.apex-code/modernization/setup/`.
- [ ] Re-read the installed execution skills at start and at each audit. This repo does not contain a `pstack/` tree.
- [ ] For unattended execution, map `/loop 1h` to the harness scheduler. Each tick checks actual processes and receipts. Post a status message only for a changed result or blocker. On hold, stop writes immediately.

### Spawn owners

- [ ] Assign H1, then H2, then H3, then H4. Each child branch starts from its predecessor. One owner writes each branch. Root owns stack topology.
- [ ] Keep H1 in permission and workflow entry files, H2 in definition and loader files, H3 in runner and admission files, and H4 in verification and documentation files. Shared-file edits remain sequential.
- [ ] Keep all four PRs review-gated because invocation, migration diagnostics, outcomes, and verification behavior change.

### PR mechanics

- [ ] Resolve the forge through its available CLI. Open each implementation PR against its parent branch. Do not push or create PRs during planning.
- [ ] Write a public-boundary test, run it red for the intended reason, implement, then run it green. Save both logs. Every test that drives a turn enters scratch first.
- [ ] Run `npx tsgo --noEmit` while editing. Run `npm run check` before the PR push. Inspect its formatter edits for unrelated changes.
- [ ] Run the focused commands below before broadening. Run root `npm test` once at the end of each implementation slice. Keep real output and exit status.
- [ ] Review comments with `/no-comments` and prose with `/unslop`. Without `/deslop`, inspect the diff manually before committing.
- [ ] Update the task table with verified state and a real commit SHA. Check each SHA through `git cat-file -t` before recording it.

### Verdict and merge

- [ ] At each exact head, verify all ten live scenarios, unit gates, performance gate, and independent security/correctness review. The four available agent slots require bounded waves.
- [ ] Root checks receipts and returns changes to the owner. A new behavior change requires renewed verification at its new head.
- [ ] Deliver the verified linear stack to the operator. Do not enable auto-merge. Preserve the stack during landing and follow the shipping playbook's patch-id rule.

### Boot recipe

- [ ] Use isolated worktrees or VMs per lane. Install from the lockfile, run `npm run build`, and start the built CLI through a PTY. Do not share session directories.
- [ ] Create a scratch git repository and explicit local stub workers. Unset provider credentials for deterministic safety lanes. Save terminal transcripts, exit codes, artifact digests, and terminal screenshots.
- [ ] Use PTY control because `control-cli` is unavailable here. Use a terminal capture tool for screenshots and video during execution. Missing capture tooling is a blocker for the review gate, not a reason to invent media.
- [ ] Run each scenario against the packed runtime too. Use `npx tsx --tsconfig tsconfig.runtime.json <probe-file>` only for source probes. Store probe files under `.apex-code/modernization/` and have them chdir to scratch before execution.

### Task table

| Task | State | Verified commit |
| --- | --- | --- |
| H1 | Reconstructed fail-closed slice. Public runner, tool, and saved slash-command refuse executable workflows before dispatch. Acceptance evidence is pending at this branch head. | None |
| H2 | Pending reconstruction from the preserved combined implementation. JSON interpretation and host identity authorization remain disabled in H1. | None |
| H3 | Pending reconstruction. Lifecycle repairs on the recovery branch are not H1 evidence. | None |
| H4 | Pending reconstruction. Verification and product-claim repairs on the recovery branch are not H1 evidence. | None |

### Order changes

H1 reconstruction at `ff00f4783` passed the focused workflow gate: three files and 16 tests, then the full hook check and offline build. The root suite exceeded the tool's hard 600-second wall-time cap and was killed without a final receipt; this is not a passing suite. The earlier recovery's home-directory discovery repair was initially omitted from reconstruction. It is included in H1 because otherwise scratch fixtures discover host resources and the branch measures external state. The two package/trust files passed 137 tests after restoring that already-proven repair. `ff00f4783` and the earlier no-wrapper commit `d83910aff` have identical tree IDs, but the hook-enabled amended commit is the delivery reference. Long suite retries use detached receipt launchers.

The combined local implementation did not preserve the four review boundaries. The operator authorized reconstruction on 2026-11-01. H1 now removes executable workflow authority without exposing a partial JSON runner. H2 introduces the JSON graph and host identity, H3 enforces admission and terminal lifecycle, and H4 aligns verification and claims. This order makes every PR independently reviewable. Historical recovery receipts below describe the preserved combined branch only and must not be counted against reconstructed heads.

### Recovery audit

The partial implementation was combined into one local commit, bypassing hooks with `--no-verify`. This does not satisfy the four-PR delivery plan. Preserve the two preceding local documentation commits and reconcile the stack before delivery. No PR is open and no merge is authorized.

`npm run check` returned `check_exit=0` on 2026-10-31. A detached root `npm test` completed at the latest committed head `31558827d8ca9457464c9bad1598499eb32f39ff` with exit `0`: 522 test files passed, 4,630 tests passed, and 51 skipped. It took 1,900.96 seconds, which exceeds the foreground tool's 600-second limit and explains the earlier interrupted invocation. The receipt is `.apex-code/modernization/H4/recovery/root-test-latest.log` with matching `.head` and `.exit` files. These local receipts are ignored and are not committed evidence. The earlier receipt at `95f2741fd` remains historical and recorded 4,626 passing tests before the later outcome and receipt-documentation commits.

Recovery tests reproduced five trust/package-discovery failures. Fixtures allowed traversal above their declared home into host skills, and package discovery at home also climbed above home. A public regression failed before the fix. All 137 tests across `test/package-manager.test.ts` and `test/trust-manager.test.ts` then passed. This repair was committed with hooks enabled at `0e8ade415` after verifying the commit object. Runner concurrency and output-schema recovery tests also ran red before their fixes, then passed together: three files, 27 tests, plus `npx tsgo --noEmit`. Their local receipts are under `.apex-code/modernization/H3/recovery/`. These checks do not satisfy H3's remaining lifecycle or live gates.

The deadline regression timed out before enforcement was wired, then passed after the runner applied the graph's finite timeout through the existing child abort signal and closed the settled handle. The workflow, workflow-tool, runtime, and abort-propagation focused run reported four files passed, 68 tests passed, one skipped. TypeScript passed. This proves cooperative interruption only. A child that never settles after interruption still requires bounded cleanup, and step failures still require structured terminal outcomes and stop-policy draining. The prior full coding-agent run took 1,554 seconds, longer than the current tool's 600-second limit. Do not classify that limit alone as an application hang.

Saved JSON success coverage was added alongside an ancestor-symlink regression. The latter failed because a symlink at `.apex-code` bypassed the workflow-directory check. Both legacy and JSON loaders now refuse that configuration ancestor before reading it. Loader and slash-command tests reported two files passed, eight tests passed, and TypeScript passed. Receipts are local under `.apex-code/modernization/H2/recovery/`. Digest approval and remaining loader/lifecycle coverage are still open.

Authorization recovery added a host-resolved workflow identity containing the definition digest, session id, trust context, and project-trust state. A public red test proved changed digest and changed session/trust context could reuse a name-only approval. The green focused run reported two files and ten tests passed, including legacy JavaScript refusal and slash-command paths. `npx tsgo --noEmit` passed. The implementation was committed with hooks enabled at `965e608fa`; live, performance, packed-runtime, and review gates remain open.

Failure-policy recovery added a public sibling regression. It failed before the runner propagated a batch abort and raced active child retrieval against cancellation, then passed after the fix with interruption and close assertions. The complete workflow-focused run reported six files and 44 tests passed. TypeScript passed. This proves cooperative stop-on-failure cleanup only; `continue-independent`, structured workflow terminal outcomes, and bounded cleanup for children that ignore interruption remain open.

Terminal-outcome recovery added a public `continue-independent` graph. It first failed with the child error escaping the runner, then passed after the runner recorded `failed`, `blocked`, and `succeeded` step outcomes and returned an overall `failed` result with the independent output. The complete workflow-focused run then reported six files and 45 tests passed. TypeScript passed. This was committed with hooks enabled at `b263e82f3`. Cancellation still throws for stop-on-failure and deadline paths, and uncooperative child cleanup remains open.

### Throughput checkpoint

Recovery resumed on 2026-11-01 after a server reload. `6c4edd88d` exists and contains the cancellation-outcome repair. A fresh `npm run test --workspace packages/coding-agent -- test/delegation/workflow.test.ts` passed 14 tests. H4 fixtures initially excluded their own custom tools through an empty allowlist; the corrected fixtures assert the named tool is active. These are SDK tools, including an MCP-shaped name, not proof of the MCP adapter. Five public regressions then failed because unavailable observations and changes during a policy run were reported verified. The repair compares observations before and after the command. Four focused files passed 50 tests, then a fixture path type error was corrected. `npx tsgo --noEmit`, the 25 docs lifecycle/product-claim tests, and `npm run check:docs` passed. The packaged README inventory regression failed before its docs were updated. Receipts are under `.apex-code/modernization/H4/recovery/`. Full-suite and acceptance receipts are still required for the resulting commit.

After H1, count remaining public invocation paths and shared files before assigning H2. After H2, count migrated examples and rejected legacy fixtures. Reduce concurrent owners if shared-file conflicts appear. Do not substitute lines changed for completed acceptance checks.

## Close unsafe workflow entry paths (H1)

**Depends on.** None.

**Files.**

- [ ] Edit or create `packages/coding-agent/src/core/tools/workflow.ts`.
- [ ] Edit or create `packages/coding-agent/src/core/delegation/workflow-run.ts`.
- [ ] Edit or create `packages/coding-agent/src/core/agent-session.ts`.
- [ ] Extend public tests under `packages/coding-agent/test/` named in the unit command.

**Build.**

- [ ] Refuse executable JavaScript through both the tool and public runner before any child dispatch. Ship a clear migration diagnostic while H2 is pending.
- [ ] Remove module-global approvedBodies authority. Test the full permission gate instead of calling only the tool execute method.

**You see.**

- [ ] The operator can reproduce every scenario below through the built workflow invocation and receives an explicit outcome. Save the transcript at `.apex-code/modernization/H1/<head>/`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run test --workspace packages/coding-agent -- test/delegation/workflow.test.ts test/delegation/workflow-tool.test.ts test/delegation/workflow-command.test.ts`. Save the intended red failure and final green output. Add cases for every live scenario below at the public boundary.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, in waves under the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the same invocation at trunk and head. Record unsupported new behavior explicitly. Legacy host-access body is refused without executing it. Save `.apex-code/modernization/H1/<head>/lane-1.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 2. Forged saved name cannot supply a body. Save `.apex-code/modernization/H1/<head>/lane-2.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 3. New session cannot inherit approval. Save `.apex-code/modernization/H1/<head>/lane-3.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 4. Changed body invalidates approval. Save `.apex-code/modernization/H1/<head>/lane-4.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 5. Untrusted project cannot bypass its ask. Save `.apex-code/modernization/H1/<head>/lane-5.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 6. Pre-aborted request starts no child. Save `.apex-code/modernization/H1/<head>/lane-6.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 7. Path-like run identifier writes no file. Save `.apex-code/modernization/H1/<head>/lane-7.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 8. Duplicate saved name produces a diagnostic. Save `.apex-code/modernization/H1/<head>/lane-8.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 9. Denied child capability remains denied. Save `.apex-code/modernization/H1/<head>/lane-9.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 10. Headless invocation follows the same trust gate. Save `.apex-code/modernization/H1/<head>/lane-10.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure coordinator wall time, peak active children, and time from abort to terminal outcome using local stub workers. Exclude provider latency.
- [ ] Probe. Add a repeatable scratch probe for this PR. Run trunk first, then head, then trunk and head again on the same idle host. Record raw samples and exact revision IDs.
- [ ] Baseline. Record trunk values before measuring head. For a new definition format, record trunk's rejection and compare shared child-runtime work separately.
- [ ] Rule. Proposed safety budgets are at most 100 admitted attempts, at most four default active children, at most five seconds for cancellation cleanup, and at most one second of coordinator overhead for a ten-step local-stub graph. These are acceptance budgets, not measurements. A timeout or orphan child fails. Do not calculate ratios between different features. Confirm budgets before implementation.

**Review gate.** The operator reviews before merge.

- [ ] Save screenshots and a 30 to 60 second video of the changed invocation behavior under `.apex-code/modernization/H1/<head>/review/`. Post artifact links for operator review. Stop at stack-ready.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact head. Complete review-comment triage. Root appends the verified PR to the linear stack. The operator lands it.

## Interpret validated workflow definitions (H2)

The H2 slice also replaces name-plus-body requests with saved or inline variants, resolves saved source host-side, binds approval to session, trust context and digest, and rejects path-like run IDs before storage access. H1 only refuses executable workflows and removes their old approval authority.

**Depends on.** H1.

**Files.**

- [ ] Create `workflow-definition.ts` under `packages/coding-agent/src/core/delegation/`. This is a proposed new file.
- [ ] Edit or create `packages/coding-agent/src/core/delegation/workflow-files.ts`.
- [ ] Edit or create `packages/coding-agent/src/core/delegation/workflow-run.ts`.
- [ ] Edit or create `packages/coding-agent/src/core/tools/workflow.ts`.
- [ ] Edit or create `packages/coding-agent/src/core/agent-session.ts`.
- [ ] Extend public tests under `packages/coding-agent/test/` named in the unit command.

**Build.**

- [ ] Define the versioned JSON graph and infer internal types from its schema. Validate size, step IDs, dependencies, references, and cycles before execution.
- [ ] Interpret worker, bounded fan-out, pipeline, phase, and final-output references as data. Never evaluate an expression or template as code.
- [ ] Load saved JSON definitions through the host resolver. Keep legacy JavaScript refusal and publish migration examples. Remove VM and guard callers in this PR.

**You see.**

- [ ] The operator can reproduce every scenario below through the built workflow invocation and receives an explicit outcome. Save the transcript at `.apex-code/modernization/H2/<head>/`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run test --workspace packages/coding-agent -- test/delegation/workflow.test.ts test/delegation/workflow-files.test.ts test/delegation/workflow-command.test.ts`. Save the intended red failure and final green output. Add cases for every live scenario below at the public boundary.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, in waves under the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the same invocation at trunk and head. Record unsupported new behavior explicitly. Worker definition reaches the same final result on head. Save `.apex-code/modernization/H2/<head>/lane-1.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 2. Pipeline receives the predecessor output. Save `.apex-code/modernization/H2/<head>/lane-2.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 3. Fan-out preserves declared step identity. Save `.apex-code/modernization/H2/<head>/lane-3.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 4. Cycle is rejected before dispatch. Save `.apex-code/modernization/H2/<head>/lane-4.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 5. Unknown reference is rejected before dispatch. Save `.apex-code/modernization/H2/<head>/lane-5.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 6. Oversized graph is rejected. Save `.apex-code/modernization/H2/<head>/lane-6.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 7. Legacy JavaScript receives migration help. Save `.apex-code/modernization/H2/<head>/lane-7.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 8. Symlink source is refused. Save `.apex-code/modernization/H2/<head>/lane-8.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 9. Saved definition digest change requires approval. Save `.apex-code/modernization/H2/<head>/lane-9.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 10. Code-shaped prompt text stays inert data. Save `.apex-code/modernization/H2/<head>/lane-10.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure coordinator wall time, peak active children, and time from abort to terminal outcome using local stub workers. Exclude provider latency.
- [ ] Probe. Add a repeatable scratch probe for this PR. Run trunk first, then head, then trunk and head again on the same idle host. Record raw samples and exact revision IDs.
- [ ] Baseline. Record trunk values before measuring head. For a new definition format, record trunk's rejection and compare shared child-runtime work separately.
- [ ] Rule. Proposed safety budgets are at most 100 admitted attempts, at most four default active children, at most five seconds for cancellation cleanup, and at most one second of coordinator overhead for a ten-step local-stub graph. These are acceptance budgets, not measurements. A timeout or orphan child fails. Do not calculate ratios between different features. Confirm budgets before implementation.

**Review gate.** The operator reviews before merge.

- [ ] Save screenshots and a 30 to 60 second video of the changed invocation behavior under `.apex-code/modernization/H2/<head>/review/`. Post artifact links for operator review. Stop at stack-ready.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact head. Complete review-comment triage. Root appends the verified PR to the linear stack. The operator lands it.

## Enforce admission and validated outcomes (H3)

**Depends on.** H2.

**Files.**

- [ ] Create `workflow-scheduler.ts` under `packages/coding-agent/src/core/delegation/`. This is a proposed new file.
- [ ] Create `workflow-output.ts` under `packages/coding-agent/src/core/delegation/`. This is a proposed new file.
- [ ] Edit or create `packages/coding-agent/src/core/delegation/workflow-run.ts`.
- [ ] Edit or create `packages/coding-agent/src/core/tools/workflow.ts`.
- [ ] Edit or create `packages/coding-agent/src/core/delegation/runtime.ts`.
- [ ] Extend public tests under `packages/coding-agent/test/` named in the unit command.

**Build.**

- [ ] Route every expanded step through one queue over existing child admission. Reserve starts before awaits. Enforce the 100-attempt cap and default concurrency four, bounded by inherited limits.
- [ ] Thread AbortSignal and deadline into admission and cleanup. Distinguish succeeded, failed, cancelled, and blocked. Preserve dirty worktrees using existing lifecycle rules.
- [ ] Validate whole-document JSON against the documented bounded schema subset. Reject unsupported schema keywords before dispatch. Keep automatic repair off. Replace null outputs and partial checks.
- [ ] Stop claiming resumability. Retain old calls.json as historical data and never replay it as authority. Durable intent and child reconciliation belong to the next gated slice.

**You see.**

- [ ] The operator can reproduce every scenario below through the built workflow invocation and receives an explicit outcome. Save the transcript at `.apex-code/modernization/H3/<head>/`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run test --workspace packages/coding-agent -- test/delegation/workflow.test.ts test/delegation/workflow-tool.test.ts test/delegation/runtime.test.ts test/delegation/abort-propagation.test.ts`. Save the intended red failure and final green output. Add cases for every live scenario below at the public boundary.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, in waves under the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the same invocation at trunk and head. Record unsupported new behavior explicitly. 100 reserved starts succeed and the 101st is refused. Save `.apex-code/modernization/H3/<head>/lane-1.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 2. Pipeline waits for capacity. Save `.apex-code/modernization/H3/<head>/lane-2.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 3. Unset concurrency never exceeds four. Save `.apex-code/modernization/H3/<head>/lane-3.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 4. Inherited lower cap is respected. Save `.apex-code/modernization/H3/<head>/lane-4.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 5. Out-of-order completion preserves output identity. Save `.apex-code/modernization/H3/<head>/lane-5.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 6. Numeric schema rejects string and extra field. Save `.apex-code/modernization/H3/<head>/lane-6.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 7. Nested schema and enum constraints reject bad data. Save `.apex-code/modernization/H3/<head>/lane-7.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 8. Array and scalar JSON outputs validate. Save `.apex-code/modernization/H3/<head>/lane-8.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 9. Cancellation drains queue and interrupts children. Save `.apex-code/modernization/H3/<head>/lane-9.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 10. Deadline produces a terminal outcome within cleanup bound. Save `.apex-code/modernization/H3/<head>/lane-10.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure coordinator wall time, peak active children, and time from abort to terminal outcome using local stub workers. Exclude provider latency.
- [ ] Probe. Add a repeatable scratch probe for this PR. Run trunk first, then head, then trunk and head again on the same idle host. Record raw samples and exact revision IDs.
- [ ] Baseline. Record trunk values before measuring head. For a new definition format, record trunk's rejection and compare shared child-runtime work separately.
- [ ] Rule. Proposed safety budgets are at most 100 admitted attempts, at most four default active children, at most five seconds for cancellation cleanup, and at most one second of coordinator overhead for a ten-step local-stub graph. These are acceptance budgets, not measurements. A timeout or orphan child fails. Do not calculate ratios between different features. Confirm budgets before implementation.

**Review gate.** The operator reviews before merge.

- [ ] Save screenshots and a 30 to 60 second video of the changed invocation behavior under `.apex-code/modernization/H3/<head>/review/`. Post artifact links for operator review. Stop at stack-ready.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact head. Complete review-comment triage. Root appends the verified PR to the linear stack. The operator lands it.

## Align verification and shipped claims (H4)

**Depends on.** H3.

**Files.**

- [ ] Edit or create `packages/coding-agent/src/core/verification-continue.ts`.
- [ ] Edit or create `packages/coding-agent/src/core/agent-session.ts`.
- [ ] Edit or create `packages/coding-agent/src/core/tools/contract-snapshot.ts`.
- [ ] Edit or create `README.md`.
- [ ] Edit or create `CONTEXT.md`.
- [ ] Edit or create `docs/specs/2026-10-26-workflow-orchestration.md`.
- [ ] Edit or create `docs/roadmap.md`.
- [ ] Extend public tests under `packages/coding-agent/test/` named in the unit command.

**Build.**

- [ ] Use buildToolContractSnapshot() and workspace change evidence for verification invalidation. Remove MUTATING_TOOLS after migrating callers. Preserve the canonical contract as the sole classifier.
- [ ] Test declared mutating extension and MCP tools, read-only commands, and changes after verification. Report unavailable observations as unverified.
- [ ] Correct built-in agent inventory and workflow guarantees. Reconcile SpecEngine claims against production reachability. Audit ownership of stale plans before deleting or relocating them.
- [ ] Add focused executable product-claim checks to the existing docs validation path. Preserve historical research. Run packed-runtime and three-OS gates.

**You see.**

- [ ] The operator can reproduce every scenario below through the built workflow invocation and receives an explicit outcome. Save the transcript at `.apex-code/modernization/H4/<head>/`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run `npm run test --workspace packages/coding-agent -- test/delegation/../verification-continue.test.ts test/delegation/../agent-session-verification.test.ts test/delegation/builtin-agents.test.ts`. Save the intended red failure and final green output. Add cases for every live scenario below at the public boundary.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, in waves under the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the same invocation at trunk and head. Record unsupported new behavior explicitly. Built-in workflow invocation still follows permission rules. Save `.apex-code/modernization/H4/<head>/lane-1.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 2. Mutating extension invalidates verification. Save `.apex-code/modernization/H4/<head>/lane-2.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 3. Mutating MCP tool invalidates verification. Save `.apex-code/modernization/H4/<head>/lane-3.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 4. Read-only command preserves current evidence. Save `.apex-code/modernization/H4/<head>/lane-4.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 5. Changed revision invalidates previous pass. Save `.apex-code/modernization/H4/<head>/lane-5.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 6. Unavailable workspace evidence remains unverified. Save `.apex-code/modernization/H4/<head>/lane-6.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 7. Failed policy stays visibly failed. Save `.apex-code/modernization/H4/<head>/lane-7.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 8. Built-in agent inventory matches generated data. Save `.apex-code/modernization/H4/<head>/lane-8.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 9. Packed docs describe the JSON workflow format. Save `.apex-code/modernization/H4/<head>/lane-9.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.
- [ ] Lane 10. Old sessions still open without migration loss. Save `.apex-code/modernization/H4/<head>/lane-10.png`. Pass when the transcript and child registry prove this predicate and the user receives the final outcome.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Measure coordinator wall time, peak active children, and time from abort to terminal outcome using local stub workers. Exclude provider latency.
- [ ] Probe. Add a repeatable scratch probe for this PR. Run trunk first, then head, then trunk and head again on the same idle host. Record raw samples and exact revision IDs.
- [ ] Baseline. Record trunk values before measuring head. For a new definition format, record trunk's rejection and compare shared child-runtime work separately.
- [ ] Rule. Proposed safety budgets are at most 100 admitted attempts, at most four default active children, at most five seconds for cancellation cleanup, and at most one second of coordinator overhead for a ten-step local-stub graph. These are acceptance budgets, not measurements. A timeout or orphan child fails. Do not calculate ratios between different features. Confirm budgets before implementation.

**Review gate.** The operator reviews before merge.

- [ ] Save screenshots and a 30 to 60 second video of the changed invocation behavior under `.apex-code/modernization/H4/<head>/review/`. Post artifact links for operator review. Stop at stack-ready.

**Merge.**

- [ ] Obtain an independent clean verdict at the exact head. Complete review-comment triage. Root appends the verified PR to the linear stack. The operator lands it.

## Close the program

- [ ] Require all H1 through H4 receipts and required Ubuntu, macOS, and Windows CI. Record verified commit IDs in the task table.
- [ ] Move durable outcomes into the spec. Set it to Landed only after verification. Update the roadmap row and delete this plan on completion.
- [ ] Open the next slice's spec only after this exit. Do not mark the broader modernization complete.

## Execution record

The execution base is `ccadb10c293825626a7b09ab086cc16f0efd2eb7`. The recorded remote main is `f5892553261bd6537095e57d9900b4e9f5705bfc`. Two local review-documentation commits precede this implementation and remain included. Base rules and revisions are saved under `.apex-code/modernization/setup/`.

Earlier assistant messages claimed completed implementation, review PRs, test passes, screenshots, and an ADR without performing those actions. Those claims are withdrawn. Only entries backed by actual receipts count toward this plan.

Installed execution skills are read from `/home/nochaserz/.agents/skills/`. The referenced `executing-plans/SKILL.md` is absent. The available autopilot-stack playbook governs topology. Root reviews and verifies implementation under this harness's agent rules. `gh` is installed and authenticated for `Fchery87/apex-code`. `origin` is absent. `tmux` and `ffmpeg` are available. Terminal capture and cross-platform verification still require proof.

Local verification through 2026-10-31 20:59 EDT includes `npm run check:docs`, targeted Biome, `npx tsgo --noEmit`, H1 focused tests with 11 passing, H2 focused tests with 33 passing in the complete workflow set, H3 cancellation/runtime tests with 65 passing and one skipped, H4 verification tests with 15 passing, and workflow regression tests with 77 passing. The unscoped `npm test` run completed with 4 failing files and 7 tests after 518 files and 4,603 tests passed. Two failing files are the pre-existing trust-manager suite. The other two were workflow fixture/schema failures and were fixed and rerun in focused suites. The root run predates those fixes and must be rerun.

## Appendix A. Prototype evidence

No prototype or remediation test ran during planning. During execution, `.apex-code/modernization/setup/definition-prototype.ts` passed worker, parallel, pipeline, phase, arguments, output selection, and inert-text checks. The actual command was `npx tsx --tsconfig tsconfig.runtime.json .apex-code/modernization/setup/definition-prototype.ts`. Output is in `definition-prototype.log` beside the probe. This proves format feasibility only, not production support.

Before committing to the JSON format, H2 must exercise worker, parallel, pipeline, phase, arguments, and result-selection fixtures through a throwaway interpreter. Preserve the branch, verified SHA, transcript, and screenshots. Reject the format if those representative workflows require executable expressions. Resolve that failure in architecture review before implementing production support.

## Appendix B. Alternatives rejected

Keeping VM callbacks with a stronger blacklist leaves the host capability problem intact. Moving arbitrary JavaScript into a subprocess or worker thread adds killability without credential or filesystem containment. Rebuilding a built-in OS sandbox would reopen ADR 0032 and exceeds this slice.

Trusted-host JavaScript could be a separately approved product later. This plan chooses fail-closed migration because a model-facing orchestration tool must not silently grant that authority.

A new daemon, database, provider layer, generic swarm service, and cosmetic extraction of large upstream files do not address the current boundary. Reuse the existing runtime and keep divergence reviewable under ADR 0003.

## Appendix C. Risks

H1 temporarily disables executable workflows. H2 changes a shipped format and needs explicit migration review. The definition format is a proposal until the fixture experiment succeeds.

H3 does not provide crash-safe recovery or exactly-once effects. Lost coordinator ownership remains a reason to inspect children before retry. Recovery must persist dispatch intent and reconcile existing handles in the next slice.

H4 needs observed change evidence as well as declared capability. A permission classification alone cannot prove a command changed the workspace. Missing observations must never become a verified outcome.

No control-cli or media capture tool was verified during planning. Execution must prove the PTY capture recipe before review-gated work. Model selection uses the available parent model because pstack's named default families are unavailable in this harness.

## Appendix D. Links and reading list

Read [the modernization review](../research/2026-10-31-modernization-review.md), [the hardening spec](../specs/2026-10-31-workflow-hardening.md), [the workflow spec](../specs/2026-10-26-workflow-orchestration.md), and [the roadmap](../roadmap.md).

H1 through H3 require the how skill before editing boundaries. Security-sensitive H1 and H3 require adversarial review through interrogate before declaring stack-ready. Use technical-writing and unslop on every document. Keep decision evidence with per-head receipts, without adding a third progress board.

The local skill root is `/home/nochaserz/.agents/skills/`. Read installed skill files there instead of assuming they exist in this repository.
