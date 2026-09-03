# Spec: Workspace-aware compaction and checkpoint navigation

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-09-01 |
| Last updated | 2026-09-03 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility. Existing sessions and compaction entries remain readable when they have no workspace details. New workspace observations are additive. Existing Git checkpoint settings remain valid. Navigation will not rewrite a user's workspace implicitly. |

## Executive summary

Apex Code's compaction summary records conversation state and cumulative file-operation paths, but it does not record whether the current workspace still matches the state described by that summary. This spec adds a versioned workspace observation beside each new compaction boundary when a supported adapter can observe it, with bounded artifacts and an explicit comparison result on resume.

The model receives a short status projection, not an unbounded raw `git diff`. Workspace observation, transcript compaction, and rollback remain separate. The existing Git checkpoint engine supplies optional rollback; `/tree` and `/fork` gain explicit, mode-consistent decisions instead of silently changing files.

## Context and motivation

- `docs/research/2026-09-01-agentic-harness-capability-audit.md` and `docs/research/2026-09-01-harness-architectural-audit.md` identify the missing direct working-tree state and the disconnected checkpoint/navigation behavior. Their proposed snippets are not accepted patches.
- `docs/research/2026-09-01-compaction-working-tree-state.md` compares Pi, Prime Agent, Atomic, Oh My Pi, Claude Code, Codex CLI, Gemini CLI, OpenCode, A2A, and MCP using public first-party material available by 2026-08-31.
- `docs/specs/2026-08-13-context-engineering.md` settles the context pipeline and keeps compaction in the existing Pi path.
- `docs/specs/2026-08-28-git-checkpoints.md` defines the Git-backed checkpoint engine. It captures reversible worktree state, but session navigation does not yet invoke it.
- `docs/architecture/contracts.md` requires one declaration source for tool permission, context, capability, and evidence behavior.
- ADR 0002 prohibits using the unlicensed `c-code` tree as a source. This spec relies only on the reviewed research notes and public licensed sources.

## Current state

Apex Code has a versioned JSONL session tree, structured compaction summaries, cumulative `readFiles` and `modifiedFiles`, an artifact mechanism for normal shell output, and a Git checkpoint engine. Compaction does not query the current working tree. Tree navigation changes the active conversation but does not restore a matching checkpoint.

| Area | Current behavior | Evidence |
| --- | --- | --- |
| Compaction file state | Records summary text and cumulative file-operation paths. It does not capture the current Git or filesystem state. | `packages/coding-agent/src/core/compaction/compaction.ts:34-60,749-963`; `packages/coding-agent/src/core/compaction/utils.ts:59-78` |
| Git checkpoints | Captures and restores Git state when enabled and available. The engine is separate from compaction and navigation. | `packages/coding-agent/src/core/checkpoints/git-checkpoints.ts:113-277`; `packages/coding-agent/src/core/checkpoints/session-checkpoints.ts:14-48` |
| Tree navigation | Rebuilds conversation context. It does not invoke checkpoint restoration. | `packages/coding-agent/src/core/agent-session.ts:3499-3685` |
| Session compatibility | Existing compaction entries have no workspace details, and readers must continue to load them. | Existing session manager and compaction serialization tests |

The research comparison found no common public format for a Git-diff compaction payload. Pi, Prime Agent, Atomic, and Oh My Pi preserve transcript boundaries and file-operation metadata, while adjacent products separate context compression from filesystem checkpoints or snapshots.

## The problem

A summary can say that an agent edited `src/example.ts` without saying whether the file on disk still matches the state it summarized. The workspace may have changed through an uncommitted edit, an external editor, a shell command, a subagent, or another process. Treating the path ledger as current state is incorrect.

Injecting a complete raw diff into each compaction request is not a safe replacement. It is unbounded, can be stale before the next provider request, consumes context, and may expose source or secrets. Git also cannot describe every workspace, and a Git diff alone does not settle staged, unstaged, untracked, ignored, generated, or external changes.

## Goals

- [x] Record a versioned workspace observation with each new compaction boundary when a supported adapter can observe the workspace.
- [x] Preserve explicit `observed`, `unsupported`, `failed`, and `incomplete` outcomes. An observation must state which fields it covers rather than implying full workspace capture.
- [x] Represent tracked, staged, unstaged, untracked, deleted, and renamed paths when the selected adapter supports them. Define ignored-file, submodule, detached-HEAD, merge, symlink, and special-file behavior.
- [x] Keep larger patch or manifest content outside the session ledger as a bounded, integrity-checked artifact. Capture patch content only under an explicit privacy and retention policy.
- [x] Project only bounded workspace status, base identity, grouped changed paths, incompleteness warnings, and authorized artifact references into compaction context.
- [x] Compare a stored observation with a fresh observation on resume or at the first turn after compaction. Report `same`, `drifted`, `unavailable`, or `inconclusive` without overwriting the historical observation.
- [x] Keep workspace observation, transcript compaction, and rollback separate. Workspace capture failure must not fail otherwise successful compaction.
- [x] Define explicit `/tree` and `/fork` policies across interactive, print, JSON, RPC, and ACP modes. No mode may silently overwrite pending user changes.
- [x] Use the existing Git checkpoint engine for optional reversible restore, including a pre-restore checkpoint.
- [x] Test Git and non-Git workspaces, including unsupported adapters and concurrent external changes.

## Non-goals

- [ ] Removing Apex SDK guidance from the default prompt. Apex wants the agent to explain its own SDK. This decision is recorded in the audit review and is unrelated to workspace state.
- [ ] Injecting a full or unbounded `git diff` into every compaction request.
- [ ] Treating `readFiles` or `modifiedFiles` as proof of current disk state.
- [ ] Making Git required for compaction, resume, or session navigation.
- [ ] Promising rollback for shell commands, subagents, external editors, symlink changes, or hard-link changes unless the selected adapter observes and snapshots them.
- [ ] Automatically committing to the user's repository or changing its branch, index, stash, or `HEAD` as a side effect of compaction.
- [ ] Implementing every editor's rules-file convention or a new provider-specific compaction format.

## Alternatives considered

- **Keep only `readFiles` and `modifiedFiles`.** Rejected because they describe tool history, not current disk state.
- **Inject the complete `git diff` into every compaction request.** Rejected because it is unbounded, staleable, repository-specific, and may expose source or secrets.
- **Create a Git commit or stash for every compaction.** Rejected as the default because it changes repository state, excludes non-Git workspaces, and has ambiguous staged, untracked, ignored, and shell-file behavior. It remains an explicit rollback-adapter option.
- **Rely only on a model-generated summary.** Rejected because the model cannot distinguish intended edits from current disk state without an observation.
- **Use a workspace observation, bounded artifacts, and on-demand detail.** Chosen because it preserves direct state without making compaction depend on Git or spending the context budget on a raw patch.

## Proposed solution

### 1. Workspace observation record

Define an additive `WorkspaceStateRecord` in compaction details or a referenced session artifact. The production name may differ, but these distinctions are required:

```ts
interface WorkspaceStateRecord {
  version: 1;
  observationId: string;
  status: "observed" | "unsupported" | "failed" | "incomplete";
  backend: "git" | "filesystem" | "none";
  workspaceRoot: string;
  capturedAt: string;
  coverage: {
    tracked: boolean;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
    ignored: boolean;
    hashes: boolean;
    patch: boolean;
  };
  base?: {
    headCommit?: string;
    branch?: string;
    indexDigest?: string;
    worktreeDigest?: string;
  };
  paths: Array<{
    path: string;
    kind: "modified" | "added" | "deleted" | "renamed" | "untracked";
    staged?: boolean;
    unstaged?: boolean;
    previousPath?: string;
    contentHash?: string;
    artifactRef?: string;
  }>;
  patchArtifactRef?: string;
  patchBytes?: number;
  patchComplete?: boolean;
  warnings: string[];
}
```

`status: "observed"` means only that the adapter observed the fields named by `coverage`. `incomplete` means a configured limit prevented complete capture. `unsupported` means no adapter can observe the workspace. `failed` means an adapter attempted capture and could not complete it. None of these outcomes may be represented as a successful full snapshot.

The Git adapter must define comparison baselines for `HEAD`, index, and worktree. It must report staged and unstaged changes separately, cover untracked paths under an explicit policy, and state how it handles ignored paths, renames, submodules, detached HEAD, merge states, symlinks, and special files. It must not modify `HEAD`, the branch, index, worktree, stash, or repository config during observation.

The first non-Git implementation may return `unsupported` rather than recursively scanning an entire project. If a filesystem adapter is added, its root, include/exclude rules, symlink behavior, special-file behavior, file-count cap, byte cap, hash cap, cancellation, and permission rules must be explicit.

### 2. Artifact privacy and ownership

Metadata and hashes may be captured by default. Patch or manifest content requires an explicit configured policy with maximum bytes, retention, access permissions, and cleanup behavior. The existing artifact store must be named as the owner before implementation, or a new session-artifact owner must define equivalent guarantees.

Workspace artifacts are not part of the evidence ledger and are not automatically sent to a provider. An artifact reference does not grant retrieval permission. Retrieval uses the normal permission system and output bounds. Redaction may be an additional measure, but it is not a substitute for access control or user consent. Secrets and unrestricted file contents must not enter the JSONL ledger.

### 3. Compaction transaction and resume comparison

Compaction preparation follows this order:

1. Attempt one workspace observation with the configured adapter and cancellation signal.
2. Stage the small record and persist any bounded artifact through an integrity-checked write.
3. Generate the existing summary, adding only the bounded workspace projection.
4. Persist the compaction entry with the summary, retained-entry boundary, existing file ledger, and workspace record or artifact reference.
5. Rebuild the active context.
6. Surface capture warnings without failing successful compaction.

If summary generation fails, the prior active context remains authoritative. If artifact persistence fails, persist `failed` or `incomplete` workspace details and continue only if the normal compaction path can safely do so. A workspace change between observation and entry persistence is not silently hidden. The next comparison reports it as drift.

Keep comparison separate from the observation:

```ts
interface WorkspaceStateComparison {
  version: 1;
  comparedAt: string;
  result: "same" | "drifted" | "unavailable" | "inconclusive";
  comparedToObservationId: string;
  changedPaths?: string[];
  warnings: string[];
}
```

On resume or at the first post-compaction turn, compare when an adapter is available. Preserve the original observation as historical. If the workspace cannot be observed, report `unavailable`; do not present an old patch as current. If the adapter cannot establish a reliable comparison, report `inconclusive`.

### 4. Navigation and rollback contract

- `/tree` preview never changes files.
- Selecting a session entry does not silently restore files.
- Interactive mode asks before a restore that would change files. The safe default is keep current workspace or cancel.
- Print, JSON, RPC, and ACP callers must supply an explicit policy such as `restore`, `keep`, `fail-if-drifted`, or `cancel` when restoration could change files.
- `/fork` creates conversational state without restoring files by default. Restoration is a separate explicit action.
- If current changes could be overwritten, restoration refuses or requires an explicit destructive policy after capturing a reversible pre-restore checkpoint.
- A missing checkpoint leaves the workspace unchanged and reports that only conversational state changed.
- A failed or cancelled restore reports its outcome and leaves the session/workspace relationship explicit.

Navigation never discards pending user edits implicitly. An explicitly authorized restore may overwrite them only after the selected policy and pre-restore checkpoint requirements succeed.

## Settled storage and artifact decisions (2026-09-02, WS.1)

Binding for WS.2 through WS.6. Recorded before any production code landed.

### Storage

- Workspace state lives in **dedicated additive session entries**, not in
  `CompactionEntry.details`. Core compaction writes `{readFiles, modifiedFiles}`
  into `details`, and an extension replacing compaction replaces `details`
  wholesale (`fromHook`), so a record stored there would silently vanish for
  hook-driven compactions and would couple core state into a field documented
  as extension-owned. `CompactionEntry.details` is unchanged by this feature
  and arbitrary extension-owned details remain preserved by construction.
- The records reuse the existing additive `custom` entry type with reserved
  namespaced discriminants:
  - `apex.workspace.observation` — one `WorkspaceStateRecord`;
  - `apex.workspace.comparison` — one `WorkspaceStateComparison`.
- The observation entry is appended as a **child of the compaction entry it
  annotates** (`parentId` = the compaction entry id). Comparisons append later
  in the path and never rewrite the historical observation.
- ADR 0006 needs **no amendment**: no new entry type, no field meaning change,
  and readers already ignore unknown entry payloads. This reuse of the existing
  `custom` type is why no new public session-format decision is being made.
- Neither record participates in LLM context (`custom` entries produce no
  context messages). The model sees only the bounded projection carried by the
  compaction summary text (WS.4) and drift notices (WS.5).

### Artifacts

- The durable owner is a **new session-owned store** on disk:
  `<sessions-dir>/<session-file-basename>.artifacts/workspace-state/`, derived
  from the session file path (`.jsonl` replaced by `.artifacts`). The existing
  `OutputAccumulator` files are ephemeral OS-temp command output and are not
  reused. An in-memory session (no file) has no artifact store; patch capture
  then reports `incomplete` coverage rather than pretending to persist.
- Writes are atomic: content lands in a unique temp file in the same directory
  and is `rename(2)`d into place. Directory mode `0o700`, file mode `0o600`.
- Every artifact carries `sha256` and byte length in its referring record;
  readers verify both and treat a mismatch as `unavailable` integrity, never
  as current state.
- Default capture is metadata and hashes only. Patch bytes require explicit
  configuration (settled with WS.3), bounded by a byte cap, FIFO-pruned by
  count and total bytes; the store owns its cleanup at write time.
- Artifact references confer no retrieval permission. Reads go through the
  normal permission system and output bounds.

## Landed behavior (2026-09-03, WS.7)

What shipped, as a reference for the names and bounds other surfaces read.

### Observation (WS.1–WS.4)

- `observeWorkspaceGit(root, options?)` in `packages/coding-agent/src/core/workspace/git-observer.ts` is the one adapter: `status` `observed` / `incomplete` / `unsupported` / `failed`, `backend` `"git"`, per-path entries `added | modified | deleted | renamed | untracked`, digest `sha256:<hex>` per path, coverage flags, and warnings. Outside a Git repository it reports `unsupported` ("not a git repository"); nothing else fails.
- Measured limits: `DEFAULT_MAX_PATHS` 200 paths per observation (truncation warning), `DEFAULT_MAX_HASH_BYTES` 5 MiB per hashed file (larger files are listed with `skipped: "size"` and no digest; symlink entries hash their target path), `DEFAULT_TIMEOUT_MS` 10 s per git call.
- Storage: additive custom entries via `appendWorkspaceObservation` / `readWorkspaceComparison` / `listWorkspaceComparisons` in `state.ts`. The observation is a child of its compaction entry and carries a stable `observationId`. `formatWorkspaceProjection` bounds what compaction context sees; the raw path list never enters the model context.
- Patch artifacts: the record schema (`patchArtifactRef`, `patchBytes`, `patchComplete`) and the `WorkspaceArtifactStore` (sequence-named files, sha256 integrity, bounded retention) exist, but no current setting writes patch content; capture is digest-only by default.
- Toplevel containment resolves both spellings through `compareToplevel` (POSIX `realpathSync`; win32 `realpathSync.native` plus case folding and `path.win32`), so macOS `/tmp` symlinks and Windows 8.3 short names cannot corrupt paths or fake escapes.
- The session excludes its own state directory (`_sessionExclusionPaths`) from observation so harness bookkeeping never reads as drift.
- Capture rides the compaction transaction (manual and auto): observer failure yields no entry and never fails the compaction.

### Comparison (WS.5)

- `compareWorkspaceObservations(stored, fresh, {artifactProbe?})` in `comparison.ts` is pure: equal digests → `same`; any moved path → `drifted` with a symmetric changed-path diff capped at `MAX_CHANGED_PATHS` 200 (plus a truncation warning); fresh `undefined` / `failed` / `unsupported` → `unavailable`; `incomplete` on either side, or digests missing where the stored record expected them, → `inconclusive`. A missing stored patch artifact adds a warning only.
- `AgentSession` runs the comparison once per boundary — the first model turn after a compaction that stored an observation, and on resume onto a session whose latest observation has no later comparison — via `_workspaceComparePending` consumed at `prompt()` start (`_runWorkspaceComparisonBoundary`, never throws). The outcome persists as an `apex.workspace.comparison` entry referencing `comparedToObservationId`; the historical observation is never rewritten.

### Navigation policies (WS.6)

- `navigateTree(targetId, { workspacePolicy?: TreeWorkspacePolicy })` with `TreeWorkspacePolicy = "keep" | "restore" | "fail-if-drifted" | "cancel"` (`"keep"` default) and a `workspace` outcome `{ policy, outcome: "unchanged" | "restored" | "refused-drifted" | "missing-checkpoint" | "failed", preRestoreCheckpoint?, warnings }`.
- `keep` never touches files. `restore` looks up the checkpoint pinned at the target entry, refuses nothing silently: missing checkpoint → `missing-checkpoint` (files unchanged), workspace drifted → files still restored through `GitCheckpoints.restore`, which pins a pre-restore checkpoint first. `fail-if-drifted` and `cancel` refuse the whole navigation (conversation untouched) when `matchesWorktree` reports drift.
- `GitCheckpoints.matchesWorktree(checkpoint)` compares a temp-index `read-tree`/`add -A`/`write-tree` against the checkpoint's commit tree; returns `undefined` when the comparison cannot run, which reports as `failed` with a warning, never as a guessed match.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| Assumption that a file-path ledger is current workspace state | behavior | retired. The new record distinguishes operation history from observation. |
| Raw `git diff` as the default compaction payload | behavior | rejected. Superseded by bounded workspace state and on-demand detail. |
| Silent filesystem changes during tree navigation | behavior | superseded by explicit restore, keep, and cancel policies. |
| Existing session entries without workspace details | format | retained. Readers remain backward compatible. |

No existing source file or session format is removed by this design.

## Risks

- A patch can contain credentials or private source. Default metadata-only capture, artifact permissions, retention, and bounded access must be tested.
- A record can become stale between capture and use. Observation IDs, timestamps, base identities, hashes, and comparisons must expose drift.
- Git status can omit untracked or ignored content. Coverage fields and tests must make omissions explicit.
- Recursive filesystem capture can scan too much or cross symlinks. The first non-Git path should be unsupported unless explicitly configured.
- An adapter failure can make compaction unreliable. Failed capture must be persisted as a status and must not block normal compaction.
- Restore can overwrite external changes. Pre-restore capture, explicit policies, and refusal on ambiguous state must run before replacement.
- Concurrent capture can observe a mixed state. The adapter must document its consistency boundary and report `inconclusive` when it cannot establish one.

## Verification

| Contract | Evidence |
| --- | --- |
| Backward compatibility | Load a pre-feature compaction entry with no workspace details and preserve its existing summary and file ledger. Ignore unknown additive workspace fields safely. |
| Git observation | Scratch Git workspaces cover clean, staged, unstaged, untracked, ignored, deleted, renamed, detached-HEAD, merge, symlink, and submodule cases where supported. Assert that observation does not modify `HEAD`, branch, index, worktree, stash, or config. |
| Non-Git behavior | A scratch non-Git workspace compacts and resumes with an explicit `unsupported` result and no recursive scan unless configured. |
| Bounds and privacy | Oversized patches/manifests produce `incomplete` details and bounded artifacts. Artifact references require permission. Secrets are not copied into the session ledger. |
| Compaction failure | Summary failure preserves the prior active context. Capture and artifact failures do not turn successful compaction into a false complete observation. |
| Resume drift | Same, drifted, unavailable, inconclusive, and concurrent-change cases produce the correct comparison without rewriting historical observations. |
| Navigation | `/tree` and `/fork` cover preview, restore, keep, cancel, missing checkpoint, failed restore, pre-restore recovery, pending changes, explicit non-interactive policies, and non-Git workspaces. |

Run focused tests first, then `npx tsgo --noEmit`, `npm test`, `npm run check`, and `node scripts/validate-docs-lifecycle.mjs .`. All session and workspace tests must use scratch directories.

## Rollout

This needs a plan because it changes compaction details, artifact handling, resume behavior, and navigation across several modes. Create a plan after this Draft spec is approved. If the workspace record or restore policy becomes an irreversible public session-format decision, write an ADR and link it here before implementation.
