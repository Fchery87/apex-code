**Status:** Active

Execution breakdown for [`docs/specs/2026-09-11-trust-classification-and-proof-integrity.md`](../specs/2026-09-11-trust-classification-and-proof-integrity.md). The spec's Rollout sets the order: goal 1 alone first, branch protection second, probes third, the criterion correction fourth, the small defects last.

## Order changes

Branch protection ran before the classifier, not second. The spec argued it should be second because later claims cite a required CI run. That reasoning applies more strongly to the classifier's own run, and enabling protection costs one API call, so doing it first made the classifier's evidence a gate rather than a report. The spec's ordering is otherwise unchanged.

## Tasks

| Task | State | Evidence |
|---|---|---|
| Enable branch protection on `main` | complete | `PUT /repos/Fchery87/apex-code/branches/main/protection` with required checks `Frozen packages match upstream`, `ubuntu-latest`, `macos-latest`, `windows-latest`; `strict: true`; force-push and deletion disabled; conversation resolution required. `GET /branches/main` now reports `protected: true` with those four contexts. `enforce_admins` is deliberately `false` and `required_pull_request_reviews` deliberately `null` — see "Deliberate limits" below. |
| Derive the trust-requiring set from one registry | complete | `packages/coding-agent/src/core/project-resources.ts` holds `PROJECT_RESOURCES`, each entry carrying a `scope` of `config-dir` or `root` and an `authority` of `presence` or `permission-scope`. `hasTrustRequiringProjectResources` iterates it instead of the deleted `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` array. |
| Close the four ungated resources | complete | `permissions.json`, `permissions.local.json`, and `agents/` are `config-dir` entries; `.mcp.json` is the first `root` entry, which is what lets a resource outside `.apex-code` reach the classifier at all. |
| Classify on authority, not presence | complete | `permissionContentConfersAuthority` in `core/permissions/store.ts` reuses the existing `parseScope`, returns false for an empty scope, and returns true when parsing throws so a malformed file prompts rather than passes. This repository's own tracked `.apex-code/permissions.json` is `{}` and therefore stays silent. |
| Keep the ancestor `.agents/skills` walk | complete | The walk and its `~/.agents/skills` exclusion are unchanged in `hasTrustRequiringProjectResources`. `ANCESTOR_PROJECT_RESOURCE` documents why it is resolved separately: the walk has no fixed depth and one path under the user's home is exempt. Covered by "keeps the ancestor .agents/skills walk and its user-level exclusion". |
| Make the registry test unable to pass with a missing entry | complete | "gates every registry entry, so a new entry cannot skip the classifier" iterates `PROJECT_RESOURCES`, creates each entry in a clean directory, and asserts the classifier flips. Adding an entry without gating it fails. The previous test enumerated filenames and so could not catch an omission. |
| Land the reproduction as a kept probe | complete | `packages/coding-agent/test/security-boundary/project-permission-trust.test.ts`, named for row 1 of the 2026-09-05 findings table. It drives the real chain (classify, derive the flag, construct the store) rather than hardcoding `projectTrusted`, and its fifth case asserts a trusted project still honors a grant so the guard is not what regresses. |
| Watch the probe fail for the right reason | complete | With `core/trust-manager.ts` reverted to its pre-fix state, 4 of 5 cases fail with `a checkout supplying a grant must not start trusted: expected true to be false`. The fifth passes in both states, which is correct: it is the control. |
| Regression sweep on adjacent suites | complete | `npx vitest run test/permissions test/trust-manager.test.ts test/startup-trust.test.ts test/trust-selector.test.ts test/mcp test/security-boundary test/delegation` — 55 files, 739 passed, 1 skipped. `npx tsgo --noEmit` exit 0. `biome check` clean on all five touched files. |
| Make `projectTrusted` required across loaders | not started | Blocked on an ADR. It is a published-API break for SDK callers, and the spec's Rollout requires the ADR before the change. Four sites currently fail open: `permissions/store.ts` `?? true`, `settings-manager.ts` twice, and `mcp/runtime.ts` treating any value but `false` as trusted. |
| Gate `AGENTS.md` and `CLAUDE.md` through the trust decision | not started | Deliberately deferred out of this slice. `core/resource-loader.ts` loads them with no trust check and `core/system-prompt.ts` wraps them as `<project_instructions>`, so the gap is real. Gating them would raise a prompt on nearly every repository that has an `AGENTS.md`, which is a product decision about first-run experience rather than part of closing this bypass. It needs its own spec section and probably its own default. |
| Refuse credential paths on the read tools | not started | Spec goal 6, the finding absent from the 2026-09-05 table. `read`/`grep`/`ls`/`find` default to allow and `path-permission.ts` performs no containment check. |
| One probe per remaining 2026-09-05 row | not started | Nineteen rows remain. Each needs a probe under `test/security-boundary/`, observed failing before it is committed, and its outcome recorded here. |
| Correct the 2026-09-05 checked criterion | not started | Reword line 50 to what was verified, and point the classifier half at this spec. |
| Atomic publish for `edit` and `write` | not started | The change belongs in `writePreparedPath` (`core/tools/path-utils.ts:193`), which truncates then writes and is the default path, not only in the two `writeFile` fallbacks. Its device and inode identity check has to survive. |
| Default `bash` timeout | not started | Blocked on an ADR and on a measurement. The spec requires the default to come from recorded long runs with the host named, not from taste. |
| Windows sandbox startup message | not started | `core/sandbox/cli-supervisor.ts:161` prints the reason with no next step, and neither `README.md` nor `docs/user-guide.md` says a Windows session needs an explicit unsandboxed mode. |

## Deliberate limits

`enforce_admins` is `false` because `scripts/release.mjs:239` runs `git push origin main` directly, and enabling admin enforcement would break the release path. The protection therefore stops accidents and red merges, not a determined administrator. Recording it here so it is a decision rather than an oversight.

`required_pull_request_reviews` is `null` because GitHub refuses to let an author approve their own pull request and this project has one maintainer (ADR 0014). Requiring a review would deadlock every pull request. The `docs/release-governance-checklist.md` line for required reviewers stays open until a second account exists.

## Verification

Task rows above carry their own evidence. Slice 1 is `62f4ee4c1`, verified with `git cat-file -t`. It carries the registry, the authority predicate, the rewritten classifier, both test files, and this plan. `npm run check` passed in the pre-commit hook at that commit.
