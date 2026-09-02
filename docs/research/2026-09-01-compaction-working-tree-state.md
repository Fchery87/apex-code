# Research: working-tree state across compaction

**Date:** 2026-09-01
**Cutoff:** 2026-08-31
**Question:** How do public Pi-derived and adjacent coding agents preserve active coding state when they compact context, and what should Apex Code do?

## Scope and method

This note uses public first-party documentation and source code from MIT-licensed Pi-derived projects and public first-party material from other coding agents. Repository links point to the latest commit on or before 2026-08-31 where a historical cutoff was needed. "Not found" means that the inspected sources did not establish a behavior. It does not prove that a private or undocumented implementation lacks it.

The prohibited `c-code` tree was not accessed. This note does not use it as a source.

## Findings by project

### Public Pi

Public Pi persists compaction as a JSONL `CompactionEntry`. The entry records the first retained session entry and token statistics. The compaction summary carries cumulative `readFiles` and `modifiedFiles` derived from tool calls. The design keeps session history and source-control rollback separate. A Git checkpoint extension exists, but it is opt-in and is not the default compaction contract.

Sources:

- [Compaction guide at the cutoff commit](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/docs/compaction.md)
- [Compaction implementation at the cutoff commit](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/compaction/compaction.ts)
- [File-operation extraction at the cutoff commit](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/src/core/compaction/utils.ts)
- [Git checkpoint example at the cutoff commit](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/examples/extensions/git-checkpoint.ts)

### Prime Agent

Prime Agent follows the Pi model. Its default compaction asks a model for a structured summary and persists a `firstKeptEntryId` boundary. It tracks cumulative read and modified file paths, but not file contents, patches, or the current working-tree diff. Git URL, branch, and HEAD metadata are recorded separately and do not enter model context. Prime also persists Python kernel state and daemon/session recovery artifacts, but those artifacts are runtime state, not workspace snapshots. Its Git checkpoint example is an opt-in extension.

Sources:

- [Prime Agent repository and MIT license](https://github.com/PrimeIntellect-ai/prime-agent/tree/9f5edc192cfe3d4737205a2f551d2b6b6e34fe09)
- [Compaction guide](https://github.com/PrimeIntellect-ai/prime-agent/blob/9f5edc192cfe3d4737205a2f551d2b6b6e34fe09/packages/coding-agent/docs/compaction.md)
- [Compaction implementation](https://github.com/PrimeIntellect-ai/prime-agent/blob/9f5edc192cfe3d4737205a2f551d2b6b6e34fe09/packages/coding-agent/src/core/compaction/compaction.ts)
- [File-operation extraction](https://github.com/PrimeIntellect-ai/prime-agent/blob/9f5edc192cfe3d4737205a2f551d2b6b6e34fe09/packages/coding-agent/src/core/compaction/utils.ts)
- [Git metadata handling](https://github.com/PrimeIntellect-ai/prime-agent/blob/9f5edc192cfe3d4737205a2f551d2b6b6e34fe09/packages/coding-agent/src/utils/git.ts)
- [Session kernel snapshots](https://github.com/PrimeIntellect-ai/prime-agent/blob/9f5edc192cfe3d4737205a2f551d2b6b6e34fe09/packages/coding-agent/src/core/kernel/state-snapshot.ts)

### Atomic

Atomic also keeps active compaction transcript-first. Its normal, RPC, automatic, and overflow paths ask a model for deletion ranges, then reconstruct the retained transcript mechanically. The durable boundary stores the retained-entry pointer, statistics, strategy, and optional session backup metadata. The backup is a copy of session JSONL, not a filesystem snapshot. Atomic does not establish working-tree diff, Git-state, or repository file-inventory capture in the active compaction boundary. Its separate branch-summary path tracks read and modified paths, but it does not capture Git state.

Sources:

- [Atomic repository and MIT license at the cutoff commit](https://github.com/bastani-inc/atomic/tree/d3910c0818bb39cb5444b23b90511140e20b1f67)
- [Atomic compaction documentation](https://docs.bastani.ai/compaction)
- [Compaction boundary](https://github.com/bastani-inc/atomic/blob/d3910c0818bb39cb5444b23b90511140e20b1f67/packages/coding-agent/src/core/compaction/compaction-boundary.ts)
- [Compaction entry types](https://github.com/bastani-inc/atomic/blob/d3910c0818bb39cb5444b23b90511140e20b1f67/packages/coding-agent/src/core/compaction/compaction-types.ts)
- [Session backup handling](https://github.com/bastani-inc/atomic/blob/d3910c0818bb39cb5444b23b90511140e20b1f67/packages/coding-agent/src/core/session-manager-archive.ts)
- [Branch file tracking](https://github.com/bastani-inc/atomic/blob/d3910c0818bb39cb5444b23b90511140e20b1f67/packages/coding-agent/src/core/compaction/branch-summarization.ts)

Atomic's separate deletion-only compaction path is useful evidence for keeping exact retained transcript data out of the model's paraphrase. It does not solve active workspace-state preservation.

### Oh My Pi

Oh My Pi is a public MIT-licensed `pi-mono` fork. At the cutoff, its portable `context-full` and `handoff` methods stored a Pi-style summary, a retained-entry boundary, and a capped inventory of paths seen in `read`, `write`, and `edit` calls. The inventory is deterministic, carries prior lists forward, and is capped in the rendered summary. It does not query Git or inspect the current worktree.

Oh My Pi has several other compaction representations:

- Provider-native OpenAI/Codex compaction keeps provider replay data in opaque `preserveData` rather than producing the normal local summary.
- `snapcompact` archives serialized conversation text and bounded PNG frames. It archives the transcript, not files or Git state.
- `shake` can move selected old transcript regions into recoverable `artifact://` payloads. Those artifacts preserve conversation material, not an authoritative filesystem snapshot.
- A session-bound file snapshot store keeps bounded file content for hashline edit validation and stale-tag recovery. It is an edit-consistency cache, not a repository-wide worktree snapshot.

A separate built-in checkpoint/rewind path branches session history. An example hook can use `git stash create` and `git stash apply`, but that is extension behavior and is not part of normal compaction. OMP's compaction methods therefore preserve recent turns plus one of several model, provider, image, or artifact representations. None automatically captures `git diff`, `git status`, staged or unstaged repository state, untracked-file content, or a durable worktree checkpoint.

Sources:

- [Oh My Pi repository and MIT license at the cutoff commit](https://github.com/can1357/oh-my-pi/tree/561d132e52c9f5b03596ec05e51451ef81aa6bd3)
- [Compaction implementation](https://github.com/can1357/oh-my-pi/blob/561d132e52c9f5b03596ec05e51451ef81aa6bd3/packages/agent/src/compaction/compaction.ts)
- [Compaction file-operation tracking](https://github.com/can1357/oh-my-pi/blob/561d132e52c9f5b03596ec05e51451ef81aa6bd3/packages/agent/src/compaction/utils.ts)
- [Compaction method choices](https://github.com/can1357/oh-my-pi/blob/561d132e52c9f5b03596ec05e51451ef81aa6bd3/packages/coding-agent/src/session/compaction-methods.ts)
- [Session-bound file snapshots](https://github.com/can1357/oh-my-pi/blob/561d132e52c9f5b03596ec05e51451ef81aa6bd3/packages/coding-agent/src/edit/file-snapshot-store.ts)
- [Artifact-backed transcript maintenance](https://github.com/can1357/oh-my-pi/blob/561d132e52c9f5b03596ec05e51451ef81aa6bd3/packages/coding-agent/src/session/session-maintenance.ts)
- [Optional Git checkpoint hook](https://github.com/can1357/oh-my-pi/blob/561d132e52c9f5b03596ec05e51451ef81aa6bd3/packages/coding-agent/examples/hooks/git-checkpoint.ts)
- [Artifact-backed transcript maintenance](https://github.com/can1357/oh-my-pi/blob/561d132e52c9f5b03596ec05e51451ef81aa6bd3/packages/coding-agent/src/session/session-maintenance.ts)
- [Optional Git checkpoint hook](https://github.com/can1357/oh-my-pi/blob/561d132e52c9f5b03596ec05e51451ef81aa6bd3/packages/coding-agent/examples/hooks/git-checkpoint.ts)

The Oh My Pi report also records two proposals that were not shipped at the cutoff. A closed lossless-context pull request proposed a queryable session projection, and an open RFC proposed additional context retention. Neither proposed or implemented automatic worktree-diff capture.

## Adjacent market behavior

The public first-party material surveyed does not define a common format for coding-state compaction. The products separate concerns in different ways.

- [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing) documents tool-edit snapshots and `/rewind` choices for code, conversation, or both. It lists limits: shell-side changes, external edits, and some file-link changes are not covered by its edit checkpoint.
- [Codex CLI compaction source at the cutoff](https://github.com/openai/codex/tree/115ffaf8bf1eda460526605cf44d9a96d88f4371) uses typed compaction items, durable rollout data, and a runtime/world-state baseline. Its [CLI reference](https://developers.openai.com/codex/cli/reference#compact) describes `/compact` as summarizing visible chat and documents `/diff` as a separate Git diff view that includes untracked files. The pinned [compaction prompt](https://github.com/openai/codex/blob/115ffaf8bf1eda460526605cf44d9a96d88f4371/codex-rs/prompts/templates/compact/prompt.md) does not require Git status, a diff, or a file manifest. Its public CLI guidance recommends user-created Git checkpoints, but the inspected compaction sources do not establish automatic repository diff injection.
- [Gemini CLI compression source at the cutoff](https://github.com/google-gemini/gemini-cli/blob/0bd1d439751478771c45d3d0895a6a9760554bf4/packages/core/src/context/contextCompressionService.ts) preserves a recent tail and a structured state snapshot with goal, constraints, file state, actions, and task state. Its optional [checkpointing guide](https://github.com/google-gemini/gemini-cli/blob/0bd1d439751478771c45d3d0895a6a9760554bf4/docs/cli/checkpointing.md) uses a shadow Git repository for approved filesystem mutations.
- [OpenCode compaction source at the cutoff](https://github.com/anomalyco/opencode/blob/04284921ac8f657555b5a182f5ff055f471543e4/packages/core/src/session/compaction.ts) keeps a structured summary, recent context, and durable context epoch. Its separate [snapshot service](https://github.com/anomalyco/opencode/blob/04284921ac8f657555b5a182f5ff055f471543e4/packages/core/src/snapshot.ts) handles file-change tracking and restore. The source does not establish that compaction injects a full Git diff.

A2A and MCP do not define this missing contract. A2A provides task continuity identifiers and artifacts, while MCP provides tools and resources. Neither specifies a local transcript compaction record or workspace snapshot format.

Sources:

- [A2A life of a task](https://github.com/a2aproject/A2A/blob/c0f30b35390c59d2cc398a1100823a9115b97a20/docs/topics/life-of-a-task.md)
- [A2A specification](https://github.com/a2aproject/A2A/blob/c0f30b35390c59d2cc398a1100823a9115b97a20/docs/specification.md)
- [MCP specification](https://modelcontextprotocol.io/specification/2025-06-18)

## Recommendation for Apex Code

Use separate records for separate jobs.

1. Keep the append-only session transcript and the existing structured compaction summary authoritative for conversational continuity.
2. Extend the compaction boundary with a versioned workspace-state record. Capture a Git or filesystem adapter result when available. Record the workspace root, capture time, base identity, status entries, changed-path categories, content hashes where available, and bounded artifact references. Record `unknown` when the adapter cannot observe a state. Do not claim that a path ledger is a snapshot.
3. Project only a short workspace status and artifact references into model context. Let the agent request an exact diff or file content on demand. Do not inject an unbounded raw `git diff` into every compaction summary.
4. Keep rollback separate from compaction. The existing Git checkpoint engine can provide reversible workspace state, but `/tree` and `/fork` must define when they capture, restore, refuse, or report drift. Git remains an optional adapter because sessions can run outside Git.
5. Preserve the last known workspace record and compare it with the current workspace on resume or after compaction. Surface drift instead of silently treating the old record as current.
6. Make the capture best effort but explicit. A failed or unsupported capture must leave a structured status and must never make compaction fail solely because the workspace is not Git-backed.
7. Test both Git and non-Git workspaces, untracked and staged changes, deleted and renamed paths, external edits, capture failure, artifact bounds, resume, and compaction failure rollback.

This approach retains direct working-tree knowledge without putting a large, stale, or repository-specific patch into the provider-facing summary. It also matches the strongest public pattern: durable transcript plus structured state, with workspace rollback as a separate capability.
