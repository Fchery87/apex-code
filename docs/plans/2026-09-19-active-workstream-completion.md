# Active workstream completion

**Status:** Active

**Date:** 2026-09-19

Cross-checked the nine roadmap rows marked active against the tree on 2026-09-19.
Eight are code-complete and need verification or doc closure. One, trust
classification and proof integrity, has five real implementation gaps. This plan
finishes the gaps, then closes every row it can close honestly. Environment note:
this run adapts the poteto multi-phase skeleton to a direct-to-main repo. One
owner, one commit per unit, no PR queue, no cloud lanes. Three-OS CI is the
external verifier and stays an operator gate because the branch is unpushed.

## Decisions taken

1. **AGENTS.md and CLAUDE.md become trust-gated.** They are project-controlled
   instruction-injection surfaces, which is exactly what the trust prompt
   exists for. The gate adds them to the gated set the registry already
   derives, so a project that has them prompts once with the other resources.
   Recorded as a spec amendment section. Reversible if the operator disagrees.
2. **Aggregate budget stays opt-in.** The unified-runs spec already recommends
   this pending replay measurements. No code change. Recorded in the spec's
   risk note.
3. **Parent-consumes-aggregate is not open.** The spec settled it; the roadmap
   row was stale.
4. **Default bash timeout value comes from measurement**, recorded in ADR 0035
   with the host named.
5. **The four `projectTrusted` sites all resolve to untrusted, not trusted.** The
   plan assumed they were legitimate grants. Reading them showed none has a trust
   answer at its call point: `main.ts` builds its startup manager 61 lines before
   `ProjectTrustStore` exists, and the other three are fallbacks reached only when
   no caller supplied a manager. ADR 0034 records the correction and the one
   behavior change it exposed.
6. **Nine of the nineteen remaining 2026-09-05 rows have no subject.** ADR 0032
   deleted `src/core/sandbox/` entirely. Probes for the CLI sandbox launcher, the
   supervisor, the credential proxy, the platform backends, and the projection
   planner would test deleted code. Ten rows survive and get probes; the nine are
   recorded as retired with the ADR that retired them.

## How to read this

One row is one unit of work with its own evidence and its own commit. A unit is
done when its evidence exists, not when its code looks right. Test-first
applies to every code unit. The plan is deleted on completion.

## Program checklist

| # | Task | State | Evidence |
| --- | --- | --- | --- |
| 0 | Measure the streaming-render bench on an idle host before any test load | done, unverified | two runs logged under `.apex-code/run-logs/2026-09-19-render-bench-head-a191f150f-*.log`; host load average 10 to 12, both runs uniformly inflated and mutually inconsistent, the AGENTS.md contamination signature; needs an idle-host rerun |
| 1 | ADR 0034 + make `projectTrusted` required at store, settings-manager, mcp runtime | done | probe `test/security-boundary/project-trust-required.test.ts` observed failing 3 of 5 with 2 controls passing in both states; 153 call sites enumerated by `tsgo` and fixed by a compiler-driven codemod; `test/security-boundary` 31 passed, permissions/trust/settings/mcp 454 passed; `npx tsgo --noEmit` exit 0 |
| 2 | Gate AGENTS.md/CLAUDE.md through the trust decision in resource-loader | done | probe `test/security-boundary/project-instructions-trust.test.ts` observed failing 5 of 7 with 2 controls passing in both states; `resource-loader.test.ts:455` asserted the hole stayed open and was flipped; affected suites 116 passed; no spec amendment needed, the deletion inventory already named `resource-loader.ts:72` and a goal was added instead |
| 3 | Atomic edit/write via temp-rename in `writePreparedPath`, remove truncate and `writeFile` fallbacks | pending | failure-simulation test first, SHA |
| 4 | ADR 0035 + default bash timeout from measurement | pending | measurement record, failing test, SHA |
| 5 | Probes for the surviving 2026-09-05 rows + criterion correction in that spec | pending | probe files, SHA |
| 6 | Unified runs, record the opt-in decision, rewrite roadmap row, delete plan | pending | spec diff, SHA |
| 7 | Permission-gate recalibration, tick spec goals, delete completed plan, roadmap row | pending | spec diff, SHA |
| 8 | Permission preview + persist-a-refusal, add persist-denial test if missing, flip Draft to Landed | pending | test run, spec diffs, SHA |
| 9 | Ember, Windows paths, shell-operation boundary, bash provider schema, verification runs then flip rows | pending | bench/suite logs, spec diffs, SHA |
| 10 | Full gates, `npm test`, `npm run check`, `npm run check:docs`, roadmap consistency | pending | command outputs |

## Verification discipline

Tests alone are not sufficient verification. A unit is verified when its
narrow tests fail first for the right reason, then pass, and `npx tsgo
--noEmit` is clean. The bench runs before any test load and reads per
AGENTS.md. Trunk and head go back to back on an idle host, and uniform
multiples across unreachable scenarios are contamination. Full `npm test` and
`npm run check` run once after the code units land and again before closure.
Three-OS CI evidence cannot exist on an unpushed branch, so closure rows land
as done-unverified where the repo demands a run id, and the operator gate is
explicit.

## Order changes

Task 0 runs before tasks 1 through 5 because any test run contaminates the
bench. Doc closures wait for code units so the roadmap is rewritten once,
truthfully.
