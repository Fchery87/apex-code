# Upstream log

Fork point and every subsequent merge. The churn and hunk numbers here are what
ADR 0003's ceiling and tripwires read. Record every merge, from the first — a metric
nobody records is a metric that cannot fire.

## Upstream identity — resolved 2026-08-08

| Field | Value |
| --- | --- |
| Canonical remote | `https://github.com/earendil-works/pi.git` |
| Also resolves | `https://github.com/earendil-works/pi-mono.git` — same repo, identical refs; the old name, still redirecting. Published docs link to it; `package.json` and npm declare `pi`. Use `pi`. |
| Default branch | `main` |
| Tags | 314, `vMAJOR.MINOR.PATCH` |
| Latest release at fork time | `v0.84.1` |
| Fork point | **`v0.84.0`** — deliberately one release behind latest, so the immediately-following release supplies a real merge rehearsal instead of a synthetic one |

## Monorepo shape at v0.84.0

Ten packages, not the four ADR 0001 was written against:

| Package | Files | Relationship to Apex Code |
| --- | --- | --- |
| `packages/coding-agent` | 634 | **forked** |
| `packages/agent` | 81 | **forked** |
| `packages/ai` | 319 | consumed |
| `packages/tui` | 91 | consumed |
| `packages/client` | 23 | consumed — **not anticipated by ADR 0001** |
| `packages/protocol` | 17 | consumed — **not anticipated by ADR 0001** |
| `packages/server` | 31 | consumed, unused |
| `packages/telemetry` | 12 | consumed, unused |
| `packages/session-backends` | 33 | **deleted 2026-08-09** — see below |
| `packages/evals` | 19 | **deleted 2026-08-09** — see below |

`packages/coding-agent` declares runtime dependencies on **five** Pi packages, not
two: `pi-agent-core`, `pi-ai`, `pi-client`, `pi-protocol`, `pi-tui` (all `^0.84.0`).
ADR 0001 originally named only `pi-ai` and `pi-tui` as consumed; it was amended on
2026-08-09 to cover the full set.

## Measured upstream churn

The leading indicator for merge burden. Measured across one **patch** release:

| Range | Scope | Files | Insertions | Deletions |
| --- | --- | --- | --- | --- |
| `v0.84.0` → `v0.84.1` | forked paths (`agent`, `coding-agent`) | 57 | 1,770 | 279 |
| `v0.84.0` → `v0.84.1` | consumed paths (`ai`, `tui`) | 35 | 1,072 | 123 |

**Read this number before planning anything.** A single patch release rewrote ~2,000
lines across 57 files in the two packages Apex Code forks. Upstream moves faster than
the fork's divergence can safely ignore, which makes the ADR 0003 cadence — merge
every release, never batch to catch up later — a hard requirement rather than a
preference.

## On the conflict-hunk baseline

ADR 0003 sets its ceiling at 3× a baseline conflicted-hunk count, and the Phase 0
plan tasks this phase with producing it. **That baseline cannot be produced now, and
the plan was wrong to expect it.**

At the fork point Apex Code has zero divergence from upstream, so every merge is
conflict-free by construction. A rehearsal today yields a hunk count of 0, and a
ceiling of 3 × 0 = 0 is not a ceiling.

What Phase 0 can honestly establish is the churn table above: how much upstream moves
per release in the paths we fork. That is a real leading indicator, it is measurable
today, and it is recorded.

The conflicted-hunk baseline becomes measurable only once Apex Code has modified
forked files — realistically after Phase 2, the first phase that changes forked code
substantially. ADR 0003 is amended accordingly: the ceiling is set from the first
three merges that follow Phase 2, not from a Phase 0 rehearsal.

## Merge history

| Date | Upstream version | Conflicted hunks | Conflicted files | Files merged (forked paths) | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-08-08 | `v0.84.0` | — | — | — | Fork point. Full-tree graft, 1,353 files. |
| 2026-08-09 | `v0.84.1` | **1** | 1 (`AGENTS.md`) | 57 (+1,770 / −279) | First real rehearsal. **0 conflicts in forked code.** Total merge: 136 files, +3,976 / −992. |
| 2026-08-27 | `v0.84.2` | **53** | 49 (27 in forked paths) | 100 (+5,654 / −4,198) | First merge since the graft that actually ran; see "The merge path was broken" below. Total: 191 files, +14,555 / −4,541. |
| 2026-08-09 | Apex Code identity rename | — (fork divergence, not a merge) | — | 218 files (+736 / −744), 602 diff hunks | Renamed the two forked package identities, active imports/docs/examples, binary, and global config root. Recorded separately from upstream merge conflicts. |

### Two kinds of merge cost, tracked separately

The rehearsal separated a distinction the plan had conflated:

**Forked-code divergence — currently 0.** No conflicts in `packages/agent` or
`packages/coding-agent`, because Apex Code has not yet modified them. All 57 changed
files merged clean. This is the number ADR 0003's ceiling is about, and it stays
uninformative until Phase 2 changes forked code.

**Identity-file cost — currently 1 hunk per release, recurring.** `AGENTS.md`,
`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` exist in both trees with
entirely different content. Every upstream release that touches one of them conflicts,
forever, resolved by taking ours each time. `v0.84.1` touched `AGENTS.md`, so: 1 hunk.

This is a permanent tax, not divergence, and it must not be counted toward the ADR 0003
ceiling — otherwise the tripwire fires on upstream editing their own README. If it ever
grows beyond a few hunks per release, the fix is to move upstream's copies aside
(`AGENTS.upstream.md`) rather than to keep resolving them; at one hunk it is not worth
the churn.

### Deleted packages — `evals` and `session-backends`

Removed 2026-08-09, before the Task 0.3 rename, because they could not be both
frozen and correct.

`packages/evals` depends on `@earendil-works/pi-coding-agent` and
`packages/session-backends/sqlite-node` on `@earendil-works/pi-agent-core` — the two
packages Task 0.3 renames. After the rename those names no longer exist in the
workspace, and the failure mode is not an error: **npm resolves them from the registry
instead**, silently building and testing against upstream's published packages while
CI reports green. Editing them to point at the new names was not available either;
that is exactly what the frozen gate forbids.

Neither is used by Apex Code. `evals` is upstream's model-evaluation harness, which
the Phase 0 spec explicitly declines to build; `session-backends` is server-side
storage with no place in the roadmap. Deleting keeps the frozen set coherent —
everything still frozen is genuinely consumed.

Root-level `package.json`, `tsconfig.json`, and `biome.json` were edited to drop the
workspace glob, the build step, the `eval` script, the path mapping, and the lint
globs. Those four files now carry permanent divergence and will conflict whenever
upstream touches them.

### Upstream defects we cannot fix

`v0.84.1` ships a real type error in a frozen package's own test file:
`packages/ai/test/openai-completions-tool-choice.test.ts` reads `.maxTokensField`
off an un-narrowed `OpenAICompletionsCompat | OpenAIResponsesCompat`. It reached a
release because upstream's `CI` workflow triggers on `main` and pull requests but
**not on tags**, so the only workflow that ran on `v0.84.1` was Build Binaries.
Their `check` never executed against the release.

We cannot repair it: `packages/ai` is frozen, and the gate rejects the edit. No
newer release exists.

Resolution: the root `tsconfig.json` excludes frozen packages' `test/**` from the
typecheck. Their `src` is still fully typechecked, because `packages/coding-agent`
imports it, so genuine breakage still surfaces. Only upstream's own test files are
dropped, and only for packages we are forbidden to edit.

The principle, worth keeping: **a CI gate that can go red for defects we may not
repair is not a gate — it is noise that trains people to ignore red.** Frozen code is
verified by byte-identity, which is the correct and sufficient check for code we do
not own. If a frozen package ever leaves the frozen set, remove its exclusion.

Worth reporting upstream. Not yet filed.

**A third category, added 2026-08-09: deleted `.github/`.** Upstream's project
automation was removed wholesale, so every future upstream change to those paths
arrives as a delete/modify conflict, resolved with `git rm` each time. Expect a
handful per release. Also excluded from the ceiling.

The graft brought in ten upstream workflows, several actively hazardous on a
different repository: `issue-analysis.yml` runs an agent against issues using
Earendil org tokens, `publish-model-catalog.yml` writes to their R2 bucket,
`build-binaries.yml` publishes `pi-*` release artifacts, and four gate/triage
workflows enforce a contribution process Apex Code does not run. Deleting was
correct rather than neutering: `.github/` is upstream's **operations**, not their
product. The packages/ argument for keeping paths mergeable does not apply, because
we want none of their CI. `.github/APPROVED_CONTRIBUTORS` and `ISSUE_TEMPLATE/` went
with them — the first was orphaned once its enforcing workflow was gone, and the
templates pointed users at Pi's Discord and Pi's contribution rules.

### Upstream defects we cannot fix — Cloudflare AI Gateway, 2026-08-24

The second instance of the same class, and the first that turned `main` red without a
commit causing it.

`packages/ai/src/providers/cloudflare-ai-gateway.ts` declares three API dialects, but
`createProvider` infers its type parameter from the **generated** model catalog rather
than from the declared return type. That catalog is built at build time from
models.dev. When models.dev stopped listing the `workers-ai/*` passthroughs under the
`cloudflare-ai-gateway` provider, the inferred union narrowed to
`"anthropic-messages" | "openai-responses"` and upstream's own source stopped
compiling:

```
src/providers/cloudflare-ai-gateway.ts(19,4): error TS2353: Object literal may only
specify known properties, and '"openai-completions"' does not exist in type
'Partial<Record<"anthropic-messages" | "openai-responses", ProviderStreams>>'
```

Note what this means. A third party's catalog edit turns this repository's `main`
red, on a commit that changed nothing related. Every green build between the fork
point and 2026-08-24 was green only because models.dev happened to list a model.

Upstream fixed it in `e8c632ef6` ("fix(ai): cloudflare gateway type, include
workers"), which does two things: pins the type parameter explicitly so the type no
longer depends on live data, and mirrors the Workers AI catalog under the documented
`workers-ai/` prefix, because the gateway `/compat` endpoint routes to those models
whether or not models.dev lists them. That commit is on upstream `main` and carries no
tag, so `v0.84.2` and `v0.84.3` both still fail. There is no pin to bump to.

**Resolved 2026-08-26 by taking the upstream fix.** The first resolution shipped a
workaround: `scripts/apex/restore-gateway-workers-models.mjs` mirrored the Workers AI
catalog above the boundary and rewrote the model data manifest to match. It reproduced
only the data half of `e8c632ef6`, not the type pinning, so the fragility remained. If
models.dev dropped the `cloudflare-workers-ai` catalog too, the mirror would have had no
source and the build would have broken the same way.

ADR 0001 was amended so the pin is a baseline tag plus backported upstream commits, and
`e8c632ef6` is now listed in `.upstream-backports`. Both halves of upstream's fix are in
the tree: the generator restores the passthroughs (17 models, one more than the
workaround produced) and the provider pins its type parameter explicitly, so the build no
longer depends on live catalog contents at all.

Verified by simulating the original failure. With the `openai-completions` group deleted
from the generated catalog, the exact state that turned `main` red, the package now
typechecks clean. Before, that state produced the TS2353 above.

The workaround and its build step are deleted. `packages/ai` is no longer byte-identical
to `v0.84.1`; it equals `v0.84.1 + e8c632ef6`, which the frozen gate verifies against
upstream's own history.

**Delete the `.upstream-backports` line** at the next upstream merge whose release
contains `e8c632ef6`. The gate enforces this rather than trusting anyone to remember: a
backport the baseline already carries fails with an instruction to delete it.


## The merge path was broken from the graft until 2026-08-27

`scripts/apex/upstream-merge.sh` could not take a release, and the way it failed looked
like nothing at all.

**The tags in this repository are not one lineage.** `v0.84.0` and `v0.84.1` arrived
with the graft, which rewrote every commit object: their trees are byte-identical to
upstream's, their shas are not. `v0.84.2` onward were fetched from upstream directly and
sit on upstream's real history. The two meet only at a 2025-11-26 merge-base with about
five thousand commits on each side.

Two consequences, both silent:

- `git fetch --quiet upstream --tags` exits non-zero rather than clobber the graft-era
  tags. Under `set -euo pipefail` that ended the script on the fetch, before it touched
  anything. This is why the fork sat on `v0.84.1` from 2026-08-07 and why an abandoned
  half-merge is parked on `fix/cloudflare-gateway-provider-api-union`.
- Had it got past the fetch, `git merge v0.84.2` would not have meant "take the next
  release". Measured 2026-08-27: **1559 files, +308419/-49265**, against **202 files,
  +10051/-4750** for the actual `v0.84.1` to `v0.84.2` change.

The script now merges with `git merge-tree --write-tree --merge-base=<pin>`, which gives
real three-way semantics with the base stated explicitly, so lineage never enters into
it. The release is taken as content rather than as a merge commit, because making
v0.84.2's unrelated history ancestors of `main` would be wrong; `.upstream-tag` and the
frozen-package gate are what record which upstream revision the consumed packages sit at.

`git apply -3` was tried first and rejected. It is atomic, so one path Apex had deleted
(`.github/APPROVED_CONTRIBUTORS`) rolled the whole thing back, and it leaves conflicted
content without unmerged index entries, so the conflict metric read **zero** for a merge
that had applied nothing. The count is now taken from conflict markers in the merged
content.

### First real measurement of the ADR 0003 metric

| Range | Conflicted hunks | Conflicted files | In forked paths | Churn in forked paths |
| --- | --- | --- | --- | --- |
| `v0.84.1` -> `v0.84.2` | 53 | 49 | 27 | 109 files, +5707 / -4232 |

This is the first number the ceiling has ever had from a merge that actually ran. The
`v0.84.1` row above records 1 conflicted hunk, measured when Apex had not yet modified
forked code; it was never a usable baseline. **The merge itself has not been taken.** It
needs 49 conflict resolutions and belongs in its own reviewed change.


## v0.84.2 — taken 2026-08-27

The first upstream release taken since the fork point, and the first measurement of the
ADR 0003 metric from a merge that ran.

| Signal | Value |
| --- | --- |
| Conflicted hunks | 53 |
| Conflicted files | 49 (27 in forked paths) |
| Churn, forked paths | 100 files, +5,654 / −4,198 |
| Churn, total | 191 files, +14,555 / −4,541 |

**Zero conflicts in frozen packages.** The ADR 0001 boundary held without intervention,
and the `e8c632ef6` backport carried across the pin bump on its own: the three-way merge
saw v0.84.2 had not touched the provider file, kept ours, and the gate went straight from
`v0.84.1 + e8c632ef6` to `v0.84.2 + e8c632ef6`.

### Where the cost actually is

Not in taking upstream's changes. In the four places Apex has genuinely diverged, each of
which needed a decision rather than a rule:

- **`system-prompt.ts`** — v0.84.2 reinstates an early-return `customPrompt` path. Apex
  replaced that with an assignment further down so tool snippets and contributed
  guidelines still append to a custom prompt. Taking upstream's block would have silently
  reverted that fix. Resolved ours.
- **`sdk.ts`** — Apex's default tool list is conditional on `lsp` and `web_search` being
  configured; upstream added `getDefaultTools()` settings support. Both, because the code
  below the conflict already reads the configured names.
- **The four core tools** — Apex's ADR 0010 `contract` and upstream's `constrainedSampling`
  are both properties of the same object, and `ApexToolDefinition extends ToolDefinition`,
  so both.
- **`interactive-mode.ts`** — Apex's renamed version-check symbols and extracted
  `publishSessionShare` flow stay; upstream's `FullscreenExitOutput` and `ToolStatus` come
  across because Apex's own code uses them.

### Three regressions the build caught, all from resolving too mechanically

1. Upstream **moved** managed-tool setup from before the TUI mounts to after it, with a
   progress callback, so slow downloads no longer look like a freeze. Keeping Apex's side
   wholesale left the old copy in place and redeclared `fdPath`. Apex's pre-mount
   permission-mode resolution is separate and stays; it has its own test.
2. `ensureTool`'s second parameter changed from `silent: boolean` to an `onStatus`
   callback. Apex's `prepareHostToolBinaries` still passed a boolean. It now renders to
   stderr, keeping stdout clean for the callers that parse it.
3. Concatenating both sides of a conflict is safe for imports and object properties and
   unsafe across statement boundaries. It cut an `it` block in half in
   `interactive-mode-startup-input.test.ts` and left it unterminated.

The general lesson for the next merge: "take ours" is wrong wherever upstream *moved*
code rather than changing it, because the conflict shows only one end of the move.
