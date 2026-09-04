# Plan: Configured verification and formatting

**Status:** Not started

**Spec:** [Configured verification and formatting](../specs/2026-09-01-configured-verification-and-formatting.md)

## Tasks

| # | Task | State | SHA | Verified by |
| --- | --- | --- | --- | --- |
| VF.1 | Settle settings ownership, precedence, and trust | Done | `423f62193` | ADR 0028 recorded; spec §1 settled subsection; 6 fixture tests (absent/inert, user untouched, trusted merge, untrusted, malformed, round-trip); tsgo + biome + 64 settings-area tests + full suite 398 files/3365 tests green |
| VF.2 | Implement strict policy loading and canonical permission projection | Done | `351e614a9` | New settings/policy tests prove argv validation, path confinement, numeric bounds, no implicit shell, project trust, precedence, denied policies, and one contract snapshot |
| VF.3 | Implement the bounded argv command executor | Done | `8fdcd3d71` | New scratch executor suite covers pass, fail, spawn failure, signal, timeout, cancellation, process-tree cleanup, UTF-8, output/artifact bounds, and no shell interpolation; three-OS CI green in run 33838960431 (repair-inclusive tree `f00df19e2`) |
| VF.4 | Integrate verification lifecycle and completion outcomes | Done | `3e8747380` | Public session and mode tests cover explicit invocation, configured boundary, pass, fail, unavailable, timeout, cancellation, continue-unverified, blocking policy, stale-after-edit, and bounded evidence; three-OS CI green in run 33838960431 (repair-inclusive tree `f00df19e2`) |
| VF.5 | Integrate formatter path scope and mutation reporting | Done | `dffb1f9d7` | Public edit/write/session tests cover declared paths, unchanged files, formatter failure, unexpected mutation, symlink escape, path traversal, timeout, cancellation, and evidence; three-OS CI green in run 33838960431 (repair-inclusive tree `f00df19e2`) |
| VF.6 | Update documentation and close the gates | Not started | — | Focused suites above, `npx tsgo --noEmit`, `npm test`, `npm run check`, `node scripts/validate-docs-lifecycle.mjs .`, and required CI evidence |

States: `Not started`, `In progress`, `Done, unverified`, `Done`.

`Done` requires a real SHA that passes `git cat-file -t` and the verification named in the row.

## Task details

### VF.1: Settle settings ownership, precedence, and trust

Choose the settings key, schema versioning, user/project/extension precedence, project-trust requirement, and whether extension policies can relax or only restrict higher-priority policy. Define policy IDs and override semantics. Decide whether the permanent public settings contract needs an ADR before code lands.

Keep the absent-policy behavior inert. No command runs during this task.

**Done when:** the spec names the final source order and trust rules, and fixtures pin the intended behavior before a loader exists.

### VF.2: Implement strict policy loading and canonical permission projection

Load executable plus argv by default. Reject malformed limits, path escapes, duplicate IDs at one precedence level, unknown required fields, and implicit shell strings. A repository file is not trusted merely because it exists. Map verification to `exec`; map formatting to `exec` plus `fs.write`; use the canonical tool contract snapshot for every descriptive surface.

**Done when:** invalid or denied policies execute nothing and loader/permission tests pass.

### VF.3: Implement the bounded argv command executor

Build or reuse one executor with cancellation, timeouts, process-tree cleanup, separate structured output metadata, bounded model output, and permitted artifact references. Reuse existing command primitives only when they meet the contract. Do not route through raw shell interpolation.

**Done when:** the executor's public tests cover every outcome and leave no descendant process or repository state behind.

### VF.4: Integrate verification lifecycle and completion outcomes

Support explicit invocation first, then the configured completion boundary. The result distinguishes verified success, failed, unavailable, cancelled, timed out, and continued without verification. A blocking failure cannot produce a verified-completion claim. Later mutations make prior verification stale.

Mode adapters render or serialize one core outcome; they do not re-run the command or invent status. Evidence stores command identity, normalized argv, cwd, outcome, duration, and bounded references, never full output.

**Done when:** public session tests and all mode adapters agree on the outcome and a mutation invalidates prior verification.

### VF.5: Integrate formatter path scope and mutation reporting

Start from public edit/write regressions. Run a formatter only when configured and authorized for the declared paths. Capture before/after workspace observations or path hashes around the command. If it writes an undeclared path, report the unexpected mutation and do not call the edit verified or formatted successfully. Refuse traversal and symlink escapes before execution.

Do not duplicate LSP diagnostics. Define and test whether formatter output is followed by diagnostics, and preserve the real formatter failure separately from edit success.

**Done when:** all path, mutation, failure, cancellation, and evidence cases pass through public mutation-tool/session boundaries.

### VF.6: Update documentation and close the gates

Document settings sources, precedence, trust, examples using argv, permission prompts, completion semantics, formatter mutation limits, and evidence fields. Run the full gates and required CI.

**Done when:** every prior task has a verified SHA, the spec and roadmap carry the landed state in the same final commit, and this plan is deleted through the normal close process.

## Order changes

None.

## Notes

VF.1 is load-bearing. VF.2 depends on it, VF.3 can begin once the policy execution contract is fixed, and VF.4/VF.5 depend on both. Keep verification and formatter wiring in separate commits even if they share the executor.

All command and session tests must use scratch directories. Do not use the repository's own session, evidence, or workspace state as a fixture.
