# Skills reach the model (Phase 2b / Phase 3 follow-up)

**Status:** Active — SKILL.2 finished, SKILL.3 next (SKILL.1's repro stays red until then, as planned)

This plan implements `docs/specs/2026-08-20-sandbox-skill-projection.md` and the catalog
decision settled in `docs/adr/0021-skill-catalog-deferral.md`. It carries no new roadmap
phase number: it repairs a defect where Phase 2b's OS boundary silently disables the
inherited skills subsystem, then completes the Phase 3 context-engineering work that
makes the repaired subsystem affordable. Task identifiers are `SKILL.n` and are stable.

Three properties govern the sequence.

**SKILL.5 is the first value milestone.** Everything before it is invisible to a user.
At SKILL.5 a user's installed skills appear in the slash menu and can be invoked by
name. That is the defect closed, and it is independently shippable.

**SKILL.8 is the second value milestone.** At SKILL.8 the model can select a skill on its
own, inside a bounded prefix. Half B is worthless without Half A and Half A is
incomplete without Half B, but only Half A is a bug fix.

**Half B cannot be measured before Half A lands.** The prefix budget is measured against
a library the child can actually see. Running the catalog work first would measure a
host-side projection that never reaches production, which is the same class of mistake
that produced the original 2,150-token figure the LSP work later found stale.

| Task | State | Commit | Verification |
| --- | --- | --- | --- |
| SKILL.1 Failing repro | Done — red confirmed, stays red until SKILL.3 | `02ebeb4c3` | Red: discovery under the child's real computed environment (`buildSandboxedCliLaunch`'s `HOME` and `APEX_CODE_CODING_AGENT_DIR`) finds zero skills with a skill present in both host roots. No sandbox required, runs on every platform. |
| SKILL.2 Supervisor resolves and mounts the roots | Done | — (uncommitted) | Red: `resolveHostSkillPaths` omits a root that does not exist; launch contract omits `skillPaths`/`APEX_CODE_SKILL_PATHS` when roots are absent, includes both when present, and the supervisor's value wins over anything of the same name already in `options.environment`. Green: `cli.ts` resolves `<hostAgentDir>/skills` and `<hostHome>/.agents/skills` via the new `resolveHostSkillPaths`, passes `skillPaths` through `launchSandboxedCli`; `cli-launch.ts`'s `buildSandboxedCliLaunch` merges them into `readOnlyPaths` and sets `APEX_CODE_SKILL_PATHS` after the allowlist spread. Escape refusal for a symlinked root is SKILL.4, not this task. |
| SKILL.3 Child discovery honours the variable | Not started | — | Red: SKILL.1's repro, inverted in this commit. Green: `package-manager.ts` registers each `APEX_CODE_SKILL_PATHS` entry as a user-scope auto root beside `userDirs.skills`. Project-scope tests unchanged. |
| SKILL.4 Escape refusal and enforced backend proof | Not started | — | Red: a root whose realpath is the host home, and a root symlinked to `$HOME`, are both refused with a startup diagnostic and absent from `skillPaths`. Green: real `bwrap` child on Linux and real `sandbox-exec` child on macOS discover a mounted skill; a write into a mounted root fails and lands in `SandboxViolationStore`. |
| SKILL.5 Command-name slugging | Not started | — | Red: a skill named `Poteto Mode` registers a command containing whitespace that the autocomplete matcher cannot resolve. Green: slugged token, raw name retained for display, divergence warned. Skill still loads — leniency preserved per `docs/skills.md` § Validation. **Value milestone: the defect is closed.** |
| SKILL.6 Catalog projection | Not started | — | Red: `formatSkillsForPrompt` emits descriptions and locations; a 500-skill library is unbounded. Green: alphabetical names only, bounded by `SKILL_CATALOG_PREFIX_BUDGET_TOKENS`, overflow states the omitted count and points at `skill_search`. |
| SKILL.7 The `skill_search` tool | Not started | — | Red: contract enumeration, `matches(ruleForCall(p), p)` plus a negative case, unknown name returns empty rather than throwing. Green: one tool mirroring `tool_schema`'s contract — empty capabilities, `allow`, `deferSchema: false`, no evidence. No query returns names; a query returns names and descriptions. |
| SKILL.8 Budget guard | Not started | — | Red: `productionPrefixTokens()` accepts a skills set and the populated case exceeds the current ceiling. Green: ceiling fixed from a real measurement per this file's own precedent; a 500-skill library provably stays inside the catalog budget. **Value milestone: model invocation works and is bounded.** |
| SKILL.9 Docs, corpus, and closure | Not started | — | `docs/skills.md` amended for the catalog and search surface. Replay corpus byte-identical across two runs. Narrow suites, `npm run build`, `npm run check`, root `npm test`, required three-OS run. Spec and roadmap amended. Plan deleted. |

## Order changes

None yet. The spec's Rollout proposed exactly this order, and the two-half split is the
spec's own. This section stays so a later reordering is recorded rather than annotated.

## Decisions already settled, not open questions

These were resolved during the spec and ADR work and must not be relitigated inside a
task. A task may change one only by amending the spec or ADR first.

- **Names in the prefix, descriptions behind a tool.** Settled by ADR 0021 on a
  measurement: name-and-description is 6,742 tokens against 128 tokens of headroom, and
  the cheapest useful truncation still costs 18 times the headroom.
- **A token budget, not a skill count.** The catalog is the only prefix contributor sized
  by user data. A count cap still varies with name length; only a token budget is
  provable.
- **One tool, not three.** `skill_search(query?)` covers list, exact lookup, and topic
  discovery. A trio would each need a contract, permission story, and test.
- **Content stays on `read`.** `skill_search` holds no capabilities precisely because it
  performs no I/O. A content mode would duplicate `read` with a weaker permission surface.
- **User scope only.** Project skills already work inside the workspace bind, and ADR 0016
  forbids project-controlled files as supervisor input.
- **Loading stays lenient.** An invalid skill name still loads. Only the command token
  changes.
- **Mount at the original host path.** Seatbelt cannot remap a path, so a
  mount-to-a-different-destination design would be Linux-only.

## Task SKILL.1 — the failing repro

### Red

Reproduce the defect at the seam the fix will change, without requiring an enforced
sandbox, so the test runs in every CI job rather than only the Linux one.

1. Build a host layout in a temp directory: an agent dir containing `skills/<name>/SKILL.md`
   and a home dir containing `.agents/skills/<name>/SKILL.md`.
2. Compute the child's environment with the real `buildSandboxedCliLaunch`, so the test
   cannot drift from what the supervisor actually sets.
3. Point `process.env.HOME` at the launch's `HOME` and construct a `DefaultResourceLoader`
   with the launch's `APEX_CODE_CODING_AGENT_DIR` as its `agentDir`.
4. Assert both host skills are discovered.

The assertion fails today, finding zero skills, because the computed roots resolve inside
the workspace rather than on the host. A control case in the same file asserts that the
identical layout discovers both skills when the host environment is used, so the test
proves the sandbox environment is the cause rather than the fixture being wrong.

### Green

Nothing in this task. SKILL.3 makes it pass. The commit for SKILL.1 lands red on purpose,
per `AGENTS.md` § Test discipline and the spec's Verification item 1.

### Notes

The test must `chdir` nowhere and write only into its temp directories. `AGENTS.md`
forbids a test that writes into the repository's own state, and a skills test is exactly
the shape that violates it by accident.
