# Plan: Workspace-aware compaction and checkpoint navigation

**Status:** Not started

**Spec:** [Workspace-aware compaction and checkpoint navigation](../specs/2026-09-01-harness-correctness-and-workspace-state.md)

## Tasks

| # | Task | State | SHA | Verified by |
| --- | --- | --- | --- | --- |
| WS.1 | Settle storage ownership and public record shapes | Done | `e6beec2da` | Type/serialization fixtures for pre-feature entries, unknown additive fields, workspace observations, comparisons, and artifact references; `npx tsgo --noEmit`. Verified: 22 workspace tests green, full suite 391 files / 3283 tests, three-OS CI run `33707738039` green (includes the `533de14e1` exitCode repair) |
| WS.2 | Implement the read-only Git observation adapter | Done | `de5ad6276` | New focused adapter suite in scratch repositories covering clean, staged, unstaged, untracked, ignored, deleted, renamed, detached-HEAD, merge, symlink, and supported submodule cases; mutation checks for `HEAD`, branch, index, worktree, stash, and config. Verified: 16 adapter tests green, `npx tsgo --noEmit` clean, biome clean |
| WS.3 | Implement bounded workspace artifacts and privacy controls | Done | `a61ea8716` | New focused artifact suite covering metadata-only default, explicit content capture, atomic writes, hashes, bounds, retention, cleanup, denied retrieval, cancellation, and failed/incomplete states. Verified: 15 artifact/settings tests green, `npx tsgo --noEmit` clean, biome clean; CI also carries the `51d0e7f13` toplevel realpath repair for the WS.2 suite |
| WS.4 | Integrate observation into the compaction transaction | Done | 0139dacfe | `packages/coding-agent/test/compaction.test.ts`, `compaction-serialization.test.ts`, `agent-session-compaction.test.ts`, and a new workspace-compaction suite prove event order, bounded projection, extension-detail compatibility, and failure rollback |
| WS.5 | Add post-compaction and resume drift comparison | Done | 27934000c | New session-level scratch tests cover same, drifted, unavailable, inconclusive, stale artifacts, concurrent edits, reload, and one comparison per required lifecycle boundary |
| WS.6 | Add explicit `/tree` and `/fork` workspace policies | Done (pending one green CI run) | 8a36f1838 | `packages/coding-agent/test/agent-session-tree-workspace-policy.test.ts` plus the checkpoint suite: policy tests cover keep, restore (pre-restore pin and file reversal), fail-if-drifted refusal and proceed, cancel, missing checkpoint, restore failure, and a fork-never-touches-files runtime test; interactive, print, RPC, and ACP modes pass the option through, with no dedicated mode-level tests yet |
| WS.7 | Update user/session documentation and close the gates | Not started | — | Focused suites above, `npx tsgo --noEmit`, `npm test`, `npm run check`, `node scripts/validate-docs-lifecycle.mjs .`, and required CI evidence |

States: `Not started`, `In progress`, `Done, unverified`, `Done`.

`Done` requires a real SHA that passes `git cat-file -t` and the verification named in the row.

## Task details

### WS.1: Settle storage ownership and public record shapes

Decide whether `WorkspaceStateRecord` lives in namespaced core compaction details or in a dedicated additive session entry referenced by the compaction entry. Preserve arbitrary extension-owned `details`; do not overwrite or reinterpret them. Name the durable artifact owner, path layout, retention rule, integrity check, and cleanup owner. Decide whether this additive contract needs an ADR 0006 amendment before code lands.

Write compatibility fixtures first. A pre-feature compaction entry must load unchanged. A newer reader must preserve known fields and safely ignore unknown additive fields. Record types must keep observations historical and comparisons separate.

**Done when:** the spec records the final ownership decision, failing compatibility tests were observed before implementation, and the type/serialization tests pass.

### WS.2: Implement the read-only Git observation adapter

Implement observation without repository mutation. Distinguish `HEAD`, index, and worktree baselines. Report staged and unstaged state separately and make coverage for untracked and ignored paths explicit. Return `unsupported`, `failed`, or `incomplete` rather than claiming a complete snapshot when a command, limit, or repository state prevents one.

The first non-Git implementation returns `unsupported`. It must not recursively scan the workspace.

**Done when:** the adapter suite passes and before/after repository state is byte- and command-observation-identical outside its returned metadata.

### WS.3: Implement bounded workspace artifacts and privacy controls

Reuse an existing durable artifact owner only if it has the required session lifetime, atomicity, access control, and cleanup behavior. Do not treat `OutputAccumulator` temporary files as durable merely because they already exist. Default to metadata and hashes. Patch or manifest bytes require explicit configuration and must never enter session JSONL or evidence records.

**Done when:** the artifact suite proves atomic writes, integrity, bounds, retention, cleanup, permission-gated retrieval, and safe handling of interrupted writes.

### WS.4: Integrate observation into the compaction transaction

Start with a public `AgentSession.compact()` regression that fails because no workspace observation survives the boundary. Then wire one observation attempt into both manual and automatic compaction through the shared path. Preserve extension hooks and arbitrary extension details. The model-facing block contains only bounded status, base identity, grouped paths, coverage/incomplete notices, and authorized references.

Summary failure leaves the prior context active. Artifact or observation failure produces an honest workspace status and does not turn successful transcript compaction into failure.

**Done when:** manual, threshold, reactive, and mid-run compaction tests pass without duplicating the capture path.

### WS.5: Add post-compaction and resume drift comparison

Compare a fresh observation against the stored observation at the first required lifecycle boundary. Persist or display comparison results without rewriting the historical observation. Deduplicate repeated checks so attaching multiple clients or rebuilding a view does not append conflicting results.

**Done when:** fresh, drifted, unavailable, inconclusive, stale, and concurrent-change cases pass through public session APIs.

### WS.6: Add explicit `/tree` and `/fork` workspace policies

Keep preview read-only. Interactive navigation asks only when restoration can change files and defaults to keep or cancel. Non-interactive callers provide `restore`, `keep`, `fail-if-drifted`, or `cancel`. `/fork` keeps the current workspace unless restoration is requested separately. Before an authorized destructive restore, capture a reversible pre-restore checkpoint and stop if that capture fails.

Do not place terminal UI selection inside `AgentSession`. The session layer accepts a typed policy and returns typed outcomes; mode adapters own prompts and protocol representation.

**Done when:** all modes expose the same outcomes and no branch selection silently rewrites files.

### WS.7: Update documentation and close the gates

Document the observation limits, artifact privacy policy, non-Git behavior, drift statuses, and navigation choices. Update the spec with final names and any measured limits. Run the full gates and CI required by `AGENTS.md`.

**Done when:** every prior task has a verified SHA, the spec and roadmap carry the landed state in the same final commit, and this plan is deleted through the normal close process.

## Order changes

None.

## Notes

WS.1 is load-bearing. WS.2 and WS.3 depend on its ownership decisions. WS.4 depends on both. WS.5 requires the persisted observation from WS.4. WS.6 can begin after WS.1 but should land after the observation and comparison semantics are stable.

Every test that drives a session, writes an artifact, or changes Git state must change into a scratch directory before invoking the public boundary.
