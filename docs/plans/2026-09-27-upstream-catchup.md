# Upstream v0.86-v0.87 Catch-up Plan

**Status:** In progress

**Goal:** Reconcile Apex Code with upstream tags v0.86.0 through v0.87.1 while preserving Apex-owned safety, trust, product identity, and evidence behavior.

**Architecture:** Merge one upstream release at a time. At each release boundary, adapt the forked agent and coding-agent seams to upstream APIs while retaining Apex policy at the owning boundary. Verify the release before advancing the pin.

**Tech Stack:** TypeScript, Node.js, Vitest, npm workspaces, frozen-package checks.

## Tasks

| Task | State | Verification |
| --- | --- | --- |
| Reconcile v0.86.0 settings-manager merge | Verified | `npx vitest run packages/coding-agent/test/settings-manager.test.ts` — 53 passed |
| Adapt TranscriptContext and tool-schema projection APIs | Verified | 3 focused context files / 6 tests; stored declarations remain unprojected |
| Adapt replay/provider and agent test fixtures to upstream message/result types | Verified | `npx tsgo --noEmit`; included in 10-file / 198-test focused run |
| Resolve bug-report behavior without restoring an unowned upload or session-share default | Verified | 3 focused bug-report tests; local archive and Apex identity retained |
| Pass v0.86.0 build, package locks, frozen-package check, and full test gates | Verified | `npm run build:offline`; `npm run check` exit 0; `npm test`: scripts 21 passed, agent 950 passed / 1 skipped, coding-agent 3,923 passed / 51 skipped |
| Record v0.86.0 hunk/churn and decisions; commit the verified release unit | Verified | `docs/upstream-log.md`; `bd8117cd5` (`git cat-file -t` confirms commit) |
| Repeat merge, reconcile, verify, and record for v0.86.1 | Verified | `80d57edc1` (`git cat-file -t` confirms commit); `npm run check`; `npm run build:offline`; frozen-package check; `npm test`: scripts 215 passed / 4 skipped, scrubber 21 passed, agent 950 passed / 1 skipped, coding-agent 3,934 passed / 51 skipped; see `docs/upstream-log.md` |
| Repeat merge, reconcile, verify, and record for v0.87.0 | Verified | `313439b3f` (`git cat-file -t` confirms commit); `npm run check`; `npm run build:offline`; frozen-package check; `npm test`: scripts 215 passed / 4 skipped, scrubber 21 passed, agent 975 passed / 1 skipped, coding-agent 4,007 passed / 51 skipped; see `docs/upstream-log.md` |
| Repeat merge, reconcile, verify, and record for v0.87.1 | Verified | `ae6a578fd` (`git cat-file -t` confirms commit); `npm run check`; `npm run build:offline`; frozen-package check; `npm test`: scripts 215 passed / 4 skipped, scrubber 21 passed, agent 975 passed / 1 skipped, coding-agent 4,014 passed / 51 skipped; see `docs/upstream-log.md` |
| Rebase the authorized local work onto the final tag and verify | Not started | PR #148/#149 local state and final checks |

## Order changes

- Fixed the merged `settings-manager.test.ts` suite before package adaptation because it prevented every typecheck and focused test from loading.
- Upstream tag order remains sequential. No later tag is applied until the current release passes its gates and has a real recorded commit SHA.
