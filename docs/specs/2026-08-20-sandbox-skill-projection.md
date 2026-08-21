# Spec: Skills reach the model — sandbox mounts plus a budget-bounded catalog

> **Term note.** `CONTEXT.md` defines **Projection** as `buildToolContractSnapshot()`.
> This document uses "mount" for the sandbox operation to avoid overloading that term.
> The filename retains `sandbox-skill-projection` because it was already circulated;
> the sandbox source itself already says "projected" for tool binaries, so the
> collision predates this spec and is not introduced by it.

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code |
| Status | `Complete` |
| Created | `2026-08-20` |
| Last updated | `2026-08-20` |
| Roadmap phase | `none` — defect fix against Phase 2b's boundary, plus a Phase 3 context-engineering follow-through |
| Tracking issue/PR | none |
| Compatibility posture | **Preserves compatibility, with one deliberate projection change.** See below. |

**Compatibility posture.** No session format, settings key, CLI flag, or tool schema
changes, and no skill file needs editing. `--no-skills` and `enableSkillCommands: false`
behave exactly as today.

One thing does change shape on purpose. `formatSkillsForPrompt` stops emitting
descriptions and locations into the system prompt, per ADR 0021. This is a change to
what the model sees, not to what the user configures, and it is the change that makes
model-visible skills affordable at all. A user with no skills installed sees a
byte-identical prompt to today.

Skill loading stays **lenient** exactly as `packages/coding-agent/docs/skills.md`
§ Validation documents. A skill with an invalid name still loads; only its slash-command
token changes.

## Executive summary

Skills are non-functional for every user of Apex Code, and would be unaffordable if they
were fixed naively. The subsystem is implemented, correct, and accurately documented, but
every real session runs inside the Phase 2b OS sandbox, which hides the host home and
repoints `HOME` and the agent directory into the workspace, so the child loads zero
skills. This spec mounts the two user-scope skill roots read-only and tells the child
where they are, reusing the mechanism already proven for `auth.json`. Measurement then
showed the discovered skills would add 6,742 tokens to a prompt prefix with 128 tokens of
headroom, so the catalog is reduced to names inside a fixed token budget, with
descriptions resolved on demand through a `skill_search` tool. That is ADR 0011's
deferred-load pattern applied to skills, settled as ADR 0021.

## Context and motivation

- `docs/adr/0005-sandbox-boundary-guarantees.md` — establishes the whole-CLI sandbox and
  states policy "denies host-home and normal credential/session directories **unless a
  later reviewed policy explicitly supplies one**." This spec is that reviewed policy,
  scoped to two read-only directories.
- `docs/adr/0016-trust-first-supervisor-policy.md` — names skills among the inputs that
  may not configure the supervisor before project trust resolves. This spec stays inside
  that rule by resolving only **user-scope** host paths in the unsandboxed parent.
- `docs/adr/0011-deferred-schema-load-path.md` — the settled pattern for a discovery
  surface too large for the prefix. ADR 0021 extends it to skills.
- `docs/adr/0021-skill-catalog-deferral.md` — the catalog decision this spec implements,
  with the measurement table that forced it.
- `docs/roadmap.md` § Phase 4 — the static-prefix budget, re-measured to 2,500 at LSP.7.
- `docs/specs/2026-08-12-os-sandbox.md` — the phase that introduced the boundary.
- `docs/research/2026-08-08-harness-comparative-review.md:67` — records that upstream Pi
  ships no sandbox by explicit design, which is why this defect is Apex-specific.

## Current state

The skills subsystem is complete, correct, and documented. It works outside the sandbox
and is never reached inside it.

- `core/skills.ts` loads `SKILL.md` files, validates frontmatter, honors ignore files,
  resolves symlinks, and tags provenance.
- `core/package-manager.ts:2461` auto-discovers user skills from `<agentDir>/skills`,
  `:2475` from `~/.agents/skills`, and `:2409` project skills from
  `<workspace>/.apex-code/skills` behind a project-trust gate (`:2377`).
- `modes/interactive/interactive-mode.ts:712` registers each loaded skill as a
  `skill:<name>` slash command when `enableSkillCommands` is on, default `true`
  (`core/settings-manager.ts:1094`).
- `core/system-prompt.ts:66` injects loaded skills via `formatSkillsForPrompt`, which
  emits name, description, and location per skill.
- `packages/coding-agent/docs/skills.md` documents every discovery location, the command
  surface, and the lenient validation posture. It is accurate. It does not mention that
  the sandbox prevents all of it.

The sandbox is mandatory. `requiresSandboxedChild()` (`core/sandbox/cli-launch.ts:16`)
returns `true` for anything that is not a non-session subcommand, a metadata flag, or
`--help`.

The child's filesystem view and its configuration roots both differ from the host's.

- `core/sandbox/linux-backend.ts:195` passes `"--tmpfs", "/home"` to bwrap.
- `core/sandbox/macos-backend.ts:167` emits `(deny file-read* (subpath USER_HOME))`
  after a broad `(allow file-read*)`.
- `core/sandbox/cli-launch.ts:193` sets `APEX_CODE_CODING_AGENT_DIR` to
  `<workspace>/.apex-code/sandbox-agent`, and `:196` sets `HOME` to
  `<workspace>/.apex-code/sandbox-state`.

The parent already carries host state across the boundary in three shapes this spec
follows rather than invents. `cli.ts:49` passes `readOnlyPaths`; `cli.ts:48` passes
`authPath`, surfaced as `APEX_CODE_AUTH_PATH` (`cli-launch.ts:192`) and read back by
`config.ts:540`; and tool binaries mount at caller-chosen destinations.

This is Apex Code's own behavior, not upstream Pi's, so the merge cost is Apex-local
(ADR 0003).

## The problem

**Skills never reach the child.** A user with skills installed sees nothing in the slash
menu and no error. The shipped documentation tells them the feature works.

Reproduced against the current build (`0.0.1-alpha.5`, dist built 2026-08-20) by driving
the real `DefaultResourceLoader` twice, changing only the environment.

```
Host environment:            skills loaded: 115
Sandbox-equivalent:          skills loaded: 0
```

Two independent mechanisms each break discovery, and either alone is sufficient. The
host home is hidden, and the configuration roots are repointed into the workspace. The
second alone would break discovery even with a fully visible filesystem, which is why
the fix cannot be a mount change on its own.

Demonstrated directly under Apex's own bwrap flags:

```
HOME is now: /tmp/fake
does ~/.agents/skills exist?                 NO
can we see /home/<user>/.agents/skills?      NO
what is in /home ?    .    ..
```

Project-scope skills already work, because `<workspace>/.apex-code/skills` sits inside
the read-write workspace bind. Verified under the same environment: a probe skill there
loaded as `project` scope while user-scope discovery returned nothing. This narrows the
mount work to user scope.

**The naive fix does not fit the prompt budget.** Measured over the 60 model-visible
skills of a real 115-skill library:

| Projection | Prefix cost |
| --- | --- |
| Name and full description (current code) | 6,742 tokens |
| Name and description truncated to 160 characters | 3,408 tokens |
| Name and description truncated to 80 characters | 2,277 tokens |
| Name only | 486 tokens |

`ENFORCED_PRODUCTION_PREFIX_BUDGET` is 2,500 (`test/context/static-prefix.test.ts:52`)
against a measured floor of 2,372, leaving 128 tokens. Descriptions are 22,623 of the
26,753 raw bytes; names are 865. Median description length is 329 characters, so an
80-character truncation destroys most entries and still costs 18 times the headroom.

**The cost scales with user data, which no other prefix contributor does.** Names cost
about 8.1 tokens each. 300 skills cost roughly 2,430 tokens in names alone. A fixed
ceiling cannot guard a quantity the user chooses.

**The guard would not have caught any of this.** `productionPrefixTokens()`
(`test/context/static-prefix.test.ts:6`) calls `buildSystemPrompt` with no `skills`
argument, so it measures a zero-skills prefix and stays green through the whole
regression.

**A loaded skill can register an untypeable command.** A skill declaring
`name: Poteto Mode` loads, per documented leniency, and registers as
`skill:Poteto Mode`. The autocomplete matcher splits a slash command at its first space
(`packages/tui/src/autocomplete.ts`), so the command displays but never resolves. This is
invisible today because no user-scope skill loads.

## Goals

- [ ] With a skill in `~/.agents/skills` or `~/.apex-code/agent/skills`, a sandboxed
      session loads it and offers `/skill:<name>` in the slash menu.
- [ ] The model can discover and use a skill it was not told about, without the user
      typing a slash command.
- [ ] The skill catalog's prefix contribution never exceeds
      `SKILL_CATALOG_PREFIX_BUDGET_TOKENS`, for any library size, proven by a test that
      feeds a library larger than the budget.
- [ ] `productionPrefixTokens()` measures a populated skills set, and the enforced budget
      holds at its re-measured value.
- [ ] The mounted paths are read-only from the child. A write attempt fails and is
      recorded in `SandboxViolationStore`.
- [ ] A session with no host skill roots starts unchanged, with no new diagnostic, no new
      mount, and no new environment variable in the launch contract.
- [ ] Project-scope discovery is byte-identical to today, including its trust gate.
- [ ] The child's skill roots come only from the supervisor. A value for the new
      environment variable present in the invoking shell does not reach the child.
- [ ] A skill whose name is not a valid command token still loads and is invocable under
      a derived, typeable command name.
- [ ] Both backends verified enforced in CI: `bwrap` on Linux, `sandbox-exec` on macOS.

## Non-goals

- [ ] **Mounting project-scope skills.** They already work. A mount would be a second
      path to the same place and would feed project-controlled files into supervisor
      input, which ADR 0016 forbids by name.
- [ ] **Making skills writable inside the sandbox.** A skill is executable instruction
      text. Write access would let a session rewrite the instructions governing the next
      session, which is cross-session privilege escalation, not convenience.
- [ ] **Copy-on-seed mirroring, as the user-local wrapper shim does for `models.json`.**
      A copy goes stale silently, doubles per-workspace footprint, and puts a writable
      copy of instruction text inside the workspace, which is the previous non-goal by
      another route.
- [ ] **Refusing skills with invalid names.** `docs/skills.md` § Validation documents
      lenient loading as deliberate. Changing it breaks existing user libraries for a
      problem solvable at the command-name layer.
- [ ] **A content mode on `skill_search`.** The existing `read` tool already loads skill
      content, is permission-gated, and emits evidence. See ADR 0021.
- [ ] **Semantic or embedding-based skill search.** Substring and token matching over
      names and descriptions is the first cut. Ranking quality is a follow-up with its
      own measurement, not a launch requirement.
- [ ] **Writing the `docs/user-guide.md` skills section.** `packages/coding-agent/docs/skills.md`
      already documents the subsystem and is amended by this change. A user-guide entry
      has no dependency on this work.
- [ ] **Windows.** Unsupported by ADR 0005; unchanged here.

## Proposed solution

Two halves. The first gets skills into the child. The second makes them affordable once
they are there.

| Component | Change | File(s) |
| --- | --- | --- |
| Supervisor entry | Resolve `<hostAgentDir>/skills` and `<hostHome>/.agents/skills`; keep those that exist and pass the escape check; add to `readOnlyPaths`; pass as new `skillPaths` | `src/cli.ts` |
| Launch contract | Accept a `HostSkillPaths` (`agentSkills`, `agentsHomeSkills`); set `APEX_CODE_SKILL_PATH_AGENT` / `APEX_CODE_SKILL_PATH_AGENTS_HOME` after the allowlist spread so the supervisor's value always wins | `core/sandbox/cli-launch.ts` |
| Child discovery | Read both variables; register each present one as a user-scope auto-discovery root, in the same discovery mode ("pi" / "agents") its host counterpart uses | `core/package-manager.ts` |
| Catalog projection | Emit alphabetically ordered skill **names only**, until `SKILL_CATALOG_PREFIX_BUDGET_TOKENS` is spent; then emit the omitted count and a pointer to `skill_search` | `core/skills.ts`, `core/system-prompt.ts` |
| Skill search tool | New `skill_search(query?)` over the in-memory registry. No query returns names; a query returns matching names and descriptions | `core/tools/skill-search.ts`, `core/tools/index.ts` |
| Command naming | Derive the slash-command token by slugging the skill name; keep the raw name for display; warn on divergence | `modes/interactive/interactive-mode.ts` |
| Budget guard | Extend `productionPrefixTokens()` to accept a skills set; add an over-budget library case | `test/context/static-prefix.test.ts` |

**Why the mount needs nothing new from either backend.** `readOnlyMountArguments`
(`linux-backend.ts:33`) already materialises a path's ancestors with `--dir` before
`--ro-bind`, and its ancestor walk stops at `/home` specifically so a path under the home
tmpfs can be reconstructed. On macOS, `readOnlyDirs` become
`(allow file-read* (subpath RO_n))` emitted **after** `(deny file-read* USER_HOME)`
(`macos-backend.ts:167-168`), and Seatbelt's last match wins.

Paths mount at their original host locations and the child is told those locations
through the environment. This is deliberate. Seatbelt cannot remap a path, so any design
that mounted a host directory at a *different* child path would be Linux-only.

**`skill_search` contract.** Mirrors `tool_schema` (`core/tools/tool-schema.ts`), which
ADR 0011 settled: empty capability set, `defaultBehavior: "allow"` with a matcher that
never fires, `resultRecoverable: true`, `deferSchema: false`, and no evidence emission.
It answers from the registry the harness already built and performs no I/O, which is what
lets it hold no capabilities.

**Boundary invariant.** ADR 0016 requires supervisor policy to come only from the runtime
environment and explicit user or maintainer inputs, never project files. Both roots are
derived in the unsandboxed parent from `getAgentDir()` and the host home. Neither is read
from, influenced by, or located inside the workspace. The child environment is an
explicit allowlist (`buildChildEnvironment`, `cli-launch.ts:112`), so
`APEX_CODE_SKILL_PATH_AGENT` and `APEX_CODE_SKILL_PATH_AGENTS_HOME` cannot be smuggled in from the invoking shell.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `formatSkillsForPrompt` description and location output | behavior | removed from the prefix; superseded by `skill_search` per ADR 0021 |
| `skill:<raw name>` command tokens | behavior | superseded by slugged tokens; the raw name is retained as the display name |
| Zero-skills-only assertion in `productionPrefixTokens()` | test behavior | superseded by a parameterised skills set; the no-skills case is retained |
| "Skills are listed with their descriptions" in `docs/skills.md` | doc | superseded by the catalog and search description added in this change |

## Risks

**The mount is a real widening of the boundary; its read-only, user-scope shape is the
mitigation, not a reassurance.** ADR 0005 denies host-home so a compromised session
cannot read the user's files. This opens two named subtrees. The signal that this went
wrong is a mounted path resolving outside the two intended roots. Guard it with a test
asserting the resolved list contains only the two computed roots.

**A skills root that is a symlink to a broad host path.** A user could point
`~/.agents/skills` at their home directory and the mount would follow it. Mitigation:
refuse a root whose realpath is the host home or an ancestor of it, and emit a startup
diagnostic rather than silently mounting or silently skipping.

**Skills become executable instruction text crossing into the sandbox.** This is the
point of the feature and is worth stating plainly. A malicious skill on the host becomes
reachable by the agent. It is user-scope and host-authored, the same trust class as
`AGENTS.md`. It is not the trust class of a project file, which is why project skills
keep their existing trust gate. `docs/skills.md` already warns to review skill content;
this makes that warning load-bearing.

**Deferral costs a turn, and the model may not spend it.** ADR 0021 accepts one extra
turn per unfamiliar skill. The failure mode is subtler than latency: the model sees a
name, cannot judge relevance without the description, and skips the skill rather than
searching. The signal is a skill that is installed, listed, and never invoked. Measure
invocation rate against the corpus rather than assuming recognition works, and treat a
low rate as a naming problem in the catalog, not a prompt-wording problem.

**A truncated catalog hides skills from the model silently.** Over budget, some names
never appear. The omitted count is stated, but the model cannot know what it is missing.
This is an accepted consequence of a bounded prefix and is why the omitted count is
explicit rather than hidden.

**Startup cost on a host with many skills.** Discovery walks each root recursively; the
reporting host has 115 skills. The signal is startup latency. This is the same walk the
host path already performs.

## Verification

Every claim is measured, not asserted. The failing repro lands before the fix.

1. **Failing repro, committed first.** A test running discovery under the child's
   environment with a skill present in a host root, asserting zero skills load. Inverted
   in the same commit as the fix.
2. **Linux, enforced.** A real `bwrap` child with a host skill root discovers the skill
   inside the boundary. CI installs `bubblewrap` and sets the `sysctl` added by Phase
   2b's second 2026-08-13 amendment, so this runs enforced rather than skipped.
3. **macOS, enforced.** The same assertion under a real `sandbox-exec` child on
   `macos-latest`.
4. **Read-only proven.** A write into a mounted skills directory from inside the child
   fails and the refusal appears in `SandboxViolationStore`.
5. **Escape refused.** A root whose realpath is the host home is refused with a startup
   diagnostic and is absent from the launch contract's `skillPaths`.
6. **No-skills path unchanged.** With no host roots present, the launch contract contains
   neither `APEX_CODE_SKILL_PATH_AGENT` nor `APEX_CODE_SKILL_PATH_AGENTS_HOME`, and no
   additional mounts, asserted against the launch object rather than by running a
   session.
7. **Project scope unchanged.** Existing project-skill tests pass unmodified, including
   the trust gate.
8. **Command name typeable.** A `SKILL.md` declaring `name: Poteto Mode` loads, warns, and
   registers a whitespace-free command that the autocomplete matcher resolves.
9. **Catalog bounded.** A synthetic library of 500 skills produces a catalog at or below
   `SKILL_CATALOG_PREFIX_BUDGET_TOKENS`, with a correct omitted count. This is the test
   that makes the guard independent of user data.
10. **Budget holds, with skills in scope.** `productionPrefixTokens()` measures a
    populated skills set and stays at or below the re-measured ceiling. The ceiling is
    fixed from that measurement, per the precedent in `static-prefix.test.ts`.
11. **Search resolves.** `skill_search` with no query returns every loaded skill name.
    With a query it returns matching names and descriptions. An unknown name returns an
    empty result rather than an error.
12. **Replay corpus determinism.** The corpus replays byte-identically across two runs
    with skills mounted, confirming the alphabetical catalog order is stable.

`npm run typecheck`, the narrowest relevant test file, then `npm test` once at the end,
per `AGENTS.md`.

## Rollout

Needs `docs/plans/2026-08-20-sandbox-skill-projection.md`. The work spans the supervisor
entry, the launch contract, the child's discovery, the catalog projection, a new tool,
the command-name layer, and two OS backends with separate CI surfaces.

The plan should stack the two halves so each is independently verifiable. The mount half
is shippable on its own and makes slash commands work. The catalog half depends on it,
because the budget cannot be measured against a library the child cannot see.

`docs/adr/0021-skill-catalog-deferral.md` settles the catalog decision and is cited above.
No further ADR is needed. ADR 0005 already anticipated a reviewed policy supplying a
host-home path, and the mount stays inside ADR 0016's user-scope rule.

One follow-up is created and deliberately excluded. Search ranking is substring and token
matching in this change; whether skills need semantic ranking is a question with its own
measurement, and it cannot be answered before skills are used at all.

## Amendment (2026-08-20): closure — landed as SKILL.1-9, spec Complete

All nine tasks landed; the full plan lives in the (now-deleted, per `AGENTS.md`'s plan
lifecycle) `docs/plans/2026-08-20-sandbox-skill-projection.md`, task-by-task record
preserved in `docs/roadmap.md`'s Phase 2b follow-up.

**Two deviations from the design above, both driven by evidence found while
implementing, not by preference:**

1. **Wire format is two named variables, not one delimited list.** The original design
   proposed a single `APEX_CODE_SKILL_PATHS`, platform-delimiter-joined. Building
   SKILL.3 surfaced that `core/package-manager.ts` discovers `<agentDir>/skills` and
   `<home>/.agents/skills` in different modes (root `.md` files count as skills in one,
   are ignored in the other), and a flat 0-2-entry list cannot tell the child which root
   a lone survivor was. Shipped as `APEX_CODE_SKILL_PATH_AGENT` /
   `APEX_CODE_SKILL_PATH_AGENTS_HOME`, each independently present only when its root
   exists and passes the escape check. Recorded in the plan's Order changes section at
   the time; recorded here as the spec's own as-built state.
2. **The catalog truncation algorithm needed a second pass.** The first cut checked each
   candidate name against `header + names-so-far + this-name + footer`, but the
   assembled output also appends the omitted-count comment line once truncation
   happens, and that line's own cost was never reserved -- a 500-skill test caught the
   assembled text exceeding its budget by 15 tokens. Fixed with a two-phase design: try
   the full list first; only when it doesn't fit, reserve the comment line's worst-case
   cost before deciding the cutoff. `formatSkillsForPrompt`'s tests now assert the
   output's actual token length directly, not just presence of expected substrings, so
   this exact class of regression is guarded rather than merely fixed once.

**Verification, actually run (not merely planned):**

- Failing repro first: `test/sandbox/skill-discovery.test.ts` proved zero skills
  discovered under the child's real computed environment before any fix landed
  (`02ebeb4c3`), inverted once SKILL.2/3 shipped.
- Enforced Linux `bwrap`: real child reads a mounted skill's actual content back
  through the writable workspace and is refused a write into it, both proven on this
  dev host (`b8e741514`, `test/sandbox/skill-mount-enforcement.test.ts`). macOS
  `sandbox-exec` cases are written and gated `describe.skipIf`, unexercised here --
  the required three-OS CI run, not run as part of this session, is what exercises
  them; this spec does not claim macOS verification beyond that gate compiling and
  being wired correctly.
- Prefix budget measured, not assumed, per this repo's own established practice
  (`ENFORCED_PRODUCTION_PREFIX_BUDGET`'s history): no-skills floor 2,393 tokens (was
  2,372; `skill_search`'s own always-on deferred-stub cost), any populated library
  2,987 tokens, identical at 200 and 2,000 synthetic skills -- direct proof
  `SKILL_CATALOG_PREFIX_BUDGET_TOKENS` bounds by construction, not by luck. Ceiling
  raised to 3,150, a ~5.5% margin matching LSP.7's own proportional margin, not a new
  policy (`f2dd9a385`).
- Full verification suite run clean: `npm run build`, `npm run check`,
  `npm run test:scripts`, the `agent` package (20 files / 398 passed / 1 skipped / 0
  failed), and the `coding-agent` package (305 files / 2,579 passed / 57 skipped / 0
  failed, confirmed on two independent full runs after one file's flake under
  parallel load -- proven non-reproducible in isolation and absent on rerun -- was
  investigated and ruled unrelated to this change).
- Replay corpus byte-identical determinism covered by the existing, passing
  `replay-runner.test.ts`; this change adds no nondeterministic content to the static
  prefix (catalog order is alphabetical, not discovery order).

**Not done, and not claimed done:** the required three-OS (Ubuntu/macOS/Windows) CI
run this repo's own closure practice calls for (see the Phase 2b and LSP.7 roadmap
entries) was not executed as part of landing this locally-verified work. The macOS
`sandbox-exec` enforcement path and the whole Windows-unsupported posture (unchanged,
per ADR 0005) are asserted by the code and by `describe.skipIf` gating, not by a run
that actually exercised them on those platforms.
