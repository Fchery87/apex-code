# Spec: Trust classification and proof integrity

**Status:** Draft

## Metadata

| Field | Value |
| --- | --- |
| Author | Frantz Chery |
| Created | 2026-09-11 |
| Last updated | 2026-09-11 |
| Roadmap phase | Product-surface follow-up, "Trust classification and proof integrity" |
| Tracking issue/PR | none |
| Compatibility posture | Clean break for unsafe authorization outcomes. A checkout that relied on being auto-trusted because its only project file was `permissions.json`, `permissions.local.json`, `.apex-code/agents/`, or `.mcp.json` now receives an explicit trust decision. No session format, settings schema, or provider API changes. `bash` gains a default timeout, which is a behavior change for a command that previously ran unbounded; the escape hatch is an explicit larger `timeout` or the background shell. |

## Executive summary

The 2026-09-05 security-boundary remediation landed the guard that makes an untrusted project drop its authorization grants, and left the classifier that decides a project is untrusted incomplete. `hasTrustRequiringProjectResources` exists and `main.ts` consumes it, but it enumerates trust-requiring files in a hand-maintained array that four project-controlled resources are missing from, so those projects are classified trusted and the guard is satisfied rather than triggered. This change replaces the array with one registry that both the loaders and the classifier read, makes `projectTrusted` a required argument so no consumer can default to trusted, and converts the 2026-09-05 findings table into kept runnable probes. It also turns on the repository setting that the roadmap's phase evidence already assumes, and corrects a checked exit criterion that is false.

## Context and motivation

- `docs/research/2026-09-05-apex-code-audit-review-and-architecture-critique.md` lines 55 to 79 hold the confirmed-findings table this acts on. Its first row is "Project permission files bypass trust, Real defect, Confirmed statically."
- `docs/specs/2026-09-05-security-boundary-remediation.md` is the remediation for that table. It is marked landed. Its goal on line 50 reads "Untrusted projects cannot load project or local authorization grants, modes, eager MCP, hooks, or other project-controlled startup authority" and is checked.
- `docs/adr/0004-permission-rule-model.md` and `docs/adr/0016-trust-first-supervisor-policy.md` own the precedence and supervisor-input decisions this change must not disturb.
- `docs/adr/0005-sandbox-boundary-guarantees.md` owns the standing Windows exclusion. This change improves the Windows message and does not revisit the exclusion.
- `docs/release-governance-checklist.md` holds thirteen unchecked external controls. Line 14 is branch protection.

A 2026-09-11 audit reproduced the first row at `HEAD`. The reproduction is a script rather than a reading, and it is the acceptance test for goal 1.

## Current state

The classifier is an array of names checked against one directory.

`packages/coding-agent/src/core/trust-manager.ts:30-38` defines `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` as `settings.json`, `extensions`, `skills`, `prompts`, `themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`. `trust-manager.ts:191-193` tests those names against `<cwd>/.apex-code` only, then walks parents looking for `.agents/skills`.

Four project-controlled resources are read but absent from that array.

| Resource | Read at | Authority it confers |
| --- | --- | --- |
| `.apex-code/permissions.json` | `permissions/store.ts:219` | Rules and a mode at the `project` source, which outranks `user`, `cliArg`, `command`, and `session` |
| `.apex-code/permissions.local.json` | `permissions/store.ts:220` | Rules and a mode at the `local` source, which outranks `project` |
| `.apex-code/agents/` | `delegation/agents.ts:68-70` | A subagent definition carrying its own system prompt and tool list |
| `.mcp.json` | `mcp/config.ts:27`, `mcp/runtime.ts:31` | A project MCP server, including an eager one that starts during startup |

`.mcp.json` sits at the repository root, and `trust-manager.ts:191` only ever tests the `.apex-code` directory, so a root-level project resource cannot reach the classifier at all.

Trust then resolves from that classifier. `packages/coding-agent/src/main.ts:793-800` computes `hasTrustRequiringResources` from it and derives `projectTrusted` as `!hasTrustRequiringResources || trustStore.get(cwd) === true`. `core/project-trust.ts:50-52` returns `true` early on the same condition.

Every consumer of the resulting flag defaults to trusted when the argument is omitted. `permissions/store.ts:226` reads `options.projectTrusted ?? true`. `core/settings-manager.ts:548` and `:588` do the same. `mcp/runtime.ts:31` uses the project path unless the flag is exactly `false`.

One resource has no gate at all. `core/resource-loader.ts:72` loads `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` from the repository, and `core/system-prompt.ts:133-135` wraps the result as `<project_instructions>` at system-prompt privilege.

Two separate defects sit outside the trust boundary.

Neither `edit` nor `write` publishes atomically, and the default path is the worse of the two. `core/tools/edit.ts:465` and `core/tools/write.ts:326` branch on a prepared operation and call `writePreparedFile`, which reaches `writePreparedPath` at `core/tools/path-utils.ts:193`. That path opens the existing file and runs `ftruncateSync(fd, 0)` then `writeAll(fd, content)` at `core/tools/path-utils.ts:207-208`, so the file is empty on disk between the two calls. The fallback branches at `core/tools/edit.ts:466` and `core/tools/write.ts:334` call `writeFile` directly, which is also not atomic but does not leave a deliberate zero-length window. Meanwhile `packages/agent/src/harness/session/jsonl/storage.ts:33` publishes the project's own session files through a temp-file-and-rename helper. The tool that writes the user's source is less crash-safe than the one that writes our bookkeeping.

`core/tools/bash.ts:54` declares `timeout` optional with the description "no default timeout", and `core/tools/bash.ts:281` only arms a timer when the model supplied one.

On Windows, `cli.ts:112` routes every session command into the sandbox path, `core/sandbox/cli-supervisor.ts:33-36` selects the macOS or Linux backend, the Linux backend self-reports unavailable off Linux, and `core/sandbox/supervisor.ts:71` raises `SandboxUnavailableError`. `cli-supervisor.ts:161` prints the reason with no remediation. Neither `README.md` nor `docs/user-guide.md` states that a Windows session requires `--sandbox danger-full-access` to start.

Branch protection is absent rather than unverified. The public API reports `protected: false` for `main` and an empty ruleset list. Four commits landed on `main` with red CI on 2026-09-11 (`0b791ead8`, `01855109a`, `f74eabe73`, `8d096b119`) before `7bfd30934` returned it to green.

## The problem

A hand-maintained allowlist of trust-requiring filenames lives in a different file from every loader whose authority it is supposed to gate. Adding a loader does not fail any check. The result is that a repository shipping only `.apex-code/permissions.json` is classified trusted, the correct guard at `store.ts:227-230` is handed `projectTrusted: true`, and it loads the attacker's rules because it was told to.

The reproduction is `git clone && cd && apex-code`. A blanket `{"toolName":"bash","behavior":"allow"}` resolves an arbitrary piped command to `allow` under the `default` and `acceptEdits` modes with no prompt rendered. `plan` mode denies it because its floor is capability-based and does not consult rules. `SECURITY.md:39` places "a bypass of the permission system that lets a tool run without a decision" in scope.

The same file cuts the other way and the spec should say so. `SECURITY.md:53-55` states that project trust is "an input guard, not a sandbox, and it constrains nothing once a turn is running," so trust was never claimed to be the boundary. That does not rescue this defect, because the rules the untrusted file supplies are consumed by the permission gate itself rather than by the trust layer, and the gate is a boundary. It does mean the honest severity is a bypass of the gate reached through a weak input guard, not a collapsed sandbox: on Linux and macOS the OS sandbox still confines the resulting execution to the workspace and the allowlisted hosts. On Windows, where ADR 0005 provides no backend, nothing else is holding.

The test that should have caught this cannot. `packages/coding-agent/test/trust-manager.test.ts` asserts that `settings.json` and `.agents/skills` make the detector return true. It enumerates members of the array, so it passes whether or not the array is complete. A test shaped like the code it tests inherits the code's blind spot.

The same shape produced a false exit criterion. The 2026-09-05 goal was verified against the guard, which does drop project scopes when told the project is untrusted, and not against the path that decides whether to say so. The criterion reads as closed, the roadmap row reads as landed, and the defect is live. For a project whose method is that every phase exits on a verified condition, a criterion that can be satisfied without the behavior holding is more expensive than the open bug underneath it, because it removes the reason to look again.

Two smaller defects reach users directly. A crash during an edit truncates the user's source file, because the tool writes in place while the project's own state is published atomically. A model that omits `timeout` can hang a turn indefinitely with no wall-clock bound anywhere. A Windows user following the documented install cannot start a session and is given no next step.

## Goals

- [ ] The reproduction script exits zero. A directory whose only project resource is `.apex-code/permissions.json`, `.apex-code/permissions.local.json`, `.apex-code/agents/`, or `.mcp.json` requires an explicit trust decision whenever that resource confers authority. "Confers authority" is defined in the Authority, not presence section below, and an empty scope is the one case that does not.
- [ ] `hasTrustRequiringProjectResources` derives its answer from the same registry the loaders resolve their paths from, so no loader can read a project-scoped path that the classifier does not know about.
- [ ] A test enumerates the registry and asserts every entry triggers the classifier. Adding a registry entry without gating it fails that test.
- [ ] A project-scoped resource outside `.apex-code` reaches the classifier. `.mcp.json` at the repository root is the case that proves it.
- [ ] The ancestor `.agents/skills` walk survives the rewrite. A skills directory in a parent of the working directory still raises a prompt, and the user-level `~/.agents/skills` still does not.
- [ ] A resource that confers no authority does not raise a prompt. A `permissions.json` parsing to an empty scope is the case that proves it, and a resource that fails to parse does raise one.
- [ ] `projectTrusted` is a required argument on the permission store, the settings manager, and the MCP runtime. No call site can omit it and receive trusted.
- [ ] `read`, `grep`, `ls`, and `find` refuse the agent directory's `auth.json` without an explicit decision, and that refusal is not expressible as a project or local rule.
- [ ] Every row of the 2026-09-05 confirmed-findings table has one committed probe that fails while the finding is open and passes once it is closed. Each probe names its row.
- [ ] `docs/specs/2026-09-05-security-boundary-remediation.md` line 50 states what was actually verified, and the classifier half is tracked as open work rather than as a checked box.
- [ ] `main` requires the Ubuntu, macOS, and Windows `ci.yml` jobs before merge, and force-push and deletion are disallowed.
- [ ] Every item in `docs/release-governance-checklist.md` is either ticked with the evidence that settles it or annotated with why it cannot be settled yet.
- [ ] `edit` and `write` publish through the same atomic path the session storage uses, preserving the destination file's mode.
- [ ] `bash` applies a default wall-clock timeout, and the timeout that fires names itself and the escape hatch.
- [ ] A Windows session that cannot be sandboxed prints the reason and the supported next step.

## Non-goals

- [ ] This does not rework permission precedence or the capability-based mode model. `permissions/rules.ts` and `permissions/modes.ts` are the parts of this subsystem that are correctly shaped, and the resolver's source ordering is settled in ADR 0004. Touching them would enlarge the reviewable surface for no defect.
- [ ] This does not add Windows OS-level sandbox enforcement. ADR 0005 makes that a standing exclusion. This change only stops a Windows user from meeting a bare error with no path forward.
- [ ] This does not attempt prompt-injection defense. `SECURITY.md` places it out of scope and names the permission gate and the sandbox as the mitigation, which is the position this change strengthens. The one related repair here is that `AGENTS.md` and `CLAUDE.md` reach the system prompt through a gate rather than through no gate, which is a trust inconsistency and not an injection defense.
- [ ] This does not add a coverage gate. The only coverage configuration in the repository is `packages/agent/vitest.harness.config.ts`, whose `coverage.include` at line 18 names `src/harness/**` plus two files, and no workflow invokes the `coverage:harness` script that uses it. It is scoped to `packages/agent`, so it could never have measured `packages/coding-agent` whatever its include list said. The gap is that no configuration measures that package at all, which is real and is not a security boundary. Folding it in would make one spec carry two unrelated arguments. It belongs in its own follow-up.
- [ ] This does not re-verify the 2026-09-05 rows itself. Goal 7 delivers the probes; what each probe reports is an outcome, not a commitment made in advance. A probe that passes closes its row here. A probe that fails opens a repair that gets its own spec if it is not already covered above.
- [ ] This does not fix the concurrent-session hazard. `core/session-lease.ts` documents that two sessions in one worktree overwrite each other behind an advisory lease. It is a real limitation, it is honestly recorded, and a real fix is a locking design rather than a line.

## Proposed solution

### One registry, read by both sides

The defect is that authority and the gate on it are described in two places. Replace the array with a single exported registry of project-scoped resources. Each entry names its location relative to the repository root, so a root-level resource and an `.apex-code` resource are expressible in the same structure, and declares that it confers authority.

Every loader resolves its path from the registry instead of composing its own `join(cwd, ".apex-code", ...)`. The classifier iterates the registry. The two can no longer disagree, because there is one list and adding to it is how a loader gets a path at all.

An entry needs a scope, not just a name, because the resources are not all shaped alike. Three scopes cover what exists today. A config-directory entry resolves under `<cwd>/.apex-code`. A root entry resolves at `<cwd>` and is what lets `.mcp.json` reach the classifier at all. An ancestor entry walks upward from `<cwd>`, which is how `trust-manager.ts:196-200` finds a `.agents/skills` directory in a parent while excluding the user-level `~/.agents/skills`. A registry keyed only on filenames would silently drop that walk and narrow the boundary while looking like a refactor, so the scope belongs in the entry rather than in the classifier's control flow.

| Component | Change | File(s) |
| --- | --- | --- |
| Project resource registry | New. Each entry carries a scope of config-directory, root, or ancestor. Entries for `settings.json`, `extensions`, `skills`, `prompts`, `themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `permissions.json`, `permissions.local.json`, `agents/`, root `.mcp.json`, the ancestor `.agents/skills` walk, and the `AGENTS.md` and `CLAUDE.md` candidate list | new module under `core/` |
| Classifier | Derives from the registry, resolving each entry by its scope. Keeps the ancestor walk and its user-level exclusion | `core/trust-manager.ts` |
| Permission store | Resolves `project` and `local` backend paths from the registry. `projectTrusted` becomes required | `core/permissions/store.ts` |
| Settings manager | `projectTrusted` becomes required at both construction sites | `core/settings-manager.ts` |
| MCP runtime | Resolves the project config path from the registry. `projectTrusted` becomes required, and an omitted flag is a type error rather than trusted | `core/mcp/runtime.ts` |
| Delegation resolver | Resolves the project agents directory from the registry | `core/delegation/agents.ts` |
| Resource loader | Repository instruction files load through the resolved trust decision | `core/resource-loader.ts` |

Making `projectTrusted` required is the part that generalizes. Today three loaders read `?? true` and one treats any value other than `false` as trusted, so a forgotten argument fails open at four sites. A required argument turns each of those into a compile error, which is the check that keeps working when someone adds a fifth loader. This follows the same reasoning as ADR 0010's single tool-contract projection, and it is the type-level version of the registry.

### Authority, not presence

The classifier must ask whether a resource confers authority, not whether a file exists. This repository is the proof. `.apex-code/permissions.json` is tracked here and `.gitignore:86-87` records that the `project` source is versioned deliberately, so a presence-only rule would prompt on every clone of Apex Code itself for a file whose content is `{}`. A prompt that carries no decision is how users learn to dismiss prompts, which costs more than the rule gains.

Classify on parsed content. A resource that parses to an empty scope confers nothing and stays silent. A resource that parses to any rule or mode confers authority and raises the prompt.

Parsing a file to decide whether to trust it is the obvious objection, and the answer is the direction of the failure. Reuse the existing `parseScope` rather than introducing a second reader, and treat every parse failure as authority-conferring so a malformed or hostile file prompts rather than passing.

One read has to be structurally enforced, not asked for. Today the trust decision travels as a boolean and each loader reopens its own path afterward, so a file can change between the check and the use. Pass the parsed scope the classifier already read into the loader, and let the loader consume that value rather than a path plus permission to reopen it. A loader that cannot reach the filesystem for that resource cannot read a different version of it, which is a stronger guarantee than a rule saying it should not.

### The test has to be shaped differently from the code

A test that lists filenames cannot catch a missing filename. Replace it with a test that iterates the registry and asserts each entry makes the classifier return true, plus a case asserting a directory with no registry entry present returns false. Adding an entry without gating it then fails. Keep a small number of literal cases as a guard against the registry itself being emptied.

### Credential paths are not a rule's business

`read`, `grep`, `ls`, and `find` default to allow at `core/tools/read.ts:229`, `grep.ts:148`, `ls.ts:120`, and `find.ts:141`, and `core/tools/path-permission.ts` performs no containment check, so any absolute path resolves. The supervisor bind-mounts the credential file read-only at its real host path and exports `APEX_CODE_AUTH_PATH` naming it, so the file is reachable and discoverable inside the boundary. `core/auth-storage.ts:25` stores it as cleartext JSON.

Add a refusal for the agent directory's `auth.json` that no project or local rule can express, in the same spirit as the managed `policy` source surviving `bypassPermissions` at `modes.ts:52-55`. The narrow version is a denied-path set consulted before rule resolution. The alternative, routing credential reads exclusively through the existing credential proxy and dropping the bind mount, is the better end state and the larger change; prefer the refusal now and record the proxy-only direction as the follow-up.

This goal is not in the requested ordering. It is included because it is a confirmed finding from the same audit, it shares this spec's boundary, and it is absent from the 2026-09-05 table, so nothing else in the repository tracks it. Strike goal 6 if it should be sequenced separately.

### Probes, kept

The 2026-09-05 verification ran probes and retained them outside the test tree. A probe that no suite runs decays into a claim about a commit that has since moved. Land each one as a test under `packages/coding-agent/test/security-boundary/`, named for the row it proves and carrying the row's text in its describe block, so `npm test` re-answers the whole table on every run. Per AGENTS.md, each must `chdir` to a scratch directory first.

The audit's reproduction script is the first of these. It asserts four properties, and it is the acceptance test for goals 1 and 3.

### The criterion, corrected

Reword line 50 of the 2026-09-05 spec to state what was verified. A store constructed for an untrusted project excludes project and local scopes, which is true and which the probes will keep true. Add the classifier half as an open goal pointing at this spec.

This keeps a landed record landed for the work that landed, which the lifecycle validator requires to stay consistent with the roadmap row, and it removes the false sentence rather than annotating around it. The alternative, reopening that spec and flipping its row back to active, churns a permanent record and would force its status and row to move together for a defect that now has its own spec.

### Controls that already hold, and one that does not

Four checklist items are settled by public evidence and only need ticking.

Trusted Publishing is configured, and the evidence is the registry's publisher record rather than the attestation. `apex-code@0.0.6` reports `_npmUser` as `GitHub Actions` at `npm-oidc-no-reply@github.com` with a `trustedPublisher` object naming `github` and an OIDC config id. That is npm's own record of a tokenless publish for this package.

The provenance attestation is separate evidence and proves something narrower. `apex-code@0.0.6` carries two attestations, including a SLSA v1 provenance whose subject is `pkg:npm/apex-code@0.0.6` and whose build identity is `refs/tags/v0.0.6` in this repository through `.github/workflows/release.yml`. That establishes where the artifact was built, not how the publish authenticated, because `--provenance` needs only `id-token: write` and works alongside a long-lived token. Tick the Trusted Publishing line from the publisher record, and read the attestation as build identity only.

The `v0.0.6` GitHub Release carries all six named archives plus `SHA256SUMS`. Dependabot is demonstrably opening pull requests, which settles alerts and the dependency graph.

Branch protection is the item that is genuinely absent, and it is the one the roadmap depends on. Every phase row cites a green three-OS run as its evidence, and nothing prevents a red merge. Require the three `ci.yml` jobs, disallow force-push and deletion on `main`, and tick the rest with the evidence above or annotate why not.

### The two small defects and the message

`edit` and `write` publish through the same temp-file-and-rename path the session storage uses, preserving the destination mode so a rename does not silently reset permissions. The change belongs in `writePreparedPath`, not only in the two fallback branches, because the prepared path is the default and is the one that truncates. Its existing device and inode identity check has to survive, since that check is what makes the authorized target the written target. `bash` gains a generous default timeout, long enough that ordinary builds and test runs are unaffected, with the firing message naming both the explicit `timeout` argument and the background shell. The Windows sandbox error names the platform exclusion, cites ADR 0005, and states the supported next step, and `README.md` and `docs/user-guide.md` say that a Windows session requires an explicit unsandboxed mode.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES` in `core/trust-manager.ts` | code | removed, superseded by the project resource registry |
| `options.projectTrusted ?? true` at `permissions/store.ts:226` | behavior | removed, the argument becomes required |
| `projectTrusted = true` defaults at `settings-manager.ts:548` and `:588` | behavior | removed, the argument becomes required |
| `projectTrusted === false` test at `mcp/runtime.ts:31` | behavior | superseded by a required flag, so an omitted value is a type error rather than trusted |
| Per-loader `join(cwd, ".apex-code", ...)` path composition | behavior | superseded by registry resolution |
| Filename-enumerating assertions in `test/trust-manager.test.ts` | code | superseded by registry-derived assertions |
| Ungated repository instruction loading at `resource-loader.ts:72` | behavior | superseded by loading through the resolved trust decision |
| Unbounded default `bash` execution | behavior | superseded by a default wall-clock timeout, with the explicit argument and the background shell as the escape hatches |
| Truncate-in-place publish at `core/tools/path-utils.ts:207-208`, plus the direct `writeFile` fallbacks at `core/tools/edit.ts:466` and `core/tools/write.ts:334` | behavior | superseded by atomic publish that keeps the device and inode identity check |
| Retained out-of-tree probes from the 2026-09-05 verification | doc | superseded by committed tests under `test/security-boundary/` |
| The checked classifier claim at `2026-09-05-security-boundary-remediation.md:50` | doc | reworded to what was verified, with the classifier half reopened here |

No session format, settings schema, provider API, or CLI option is removed. Unsafe authorization outcomes change by design, which is the point of the change.

## Risks

| Risk | Signal | Response |
| --- | --- | --- |
| Trust gating now fires on repositories that previously started silently, and reads as a regression | Users report a new prompt on a familiar repository | The prompt is the fix. Say so in the changelog, and name the four newly gated resources |
| Presence-only classification prompts on Apex Code's own clone | Cloning this repository raises a trust prompt for a `permissions.json` containing `{}` | Classify on parsed authority rather than existence, and keep a test that clones this repository's own `.apex-code` shape and asserts silence |
| Content-sensitive classification reads a hostile file before trusting it | A malformed or adversarial `permissions.json` crashes startup or is classified silent | Reuse `parseScope`, treat any parse failure as authority-conferring, and cover malformed, truncated, and deeply nested inputs |
| A required `projectTrusted` argument breaks external SDK callers | Type errors outside this repository | This is the intended clean break. Callers that want project authority must state it. Record it in the changelog and in the SDK surface notes |
| Registry indirection becomes an abstraction nobody reads | A loader reintroduces its own path literal | The classifier test iterates the registry, and a loader with a literal path has no entry, so its resource is ungated and the probe for it fails |
| A default `bash` timeout kills a legitimate long build | A previously working command times out | Derive the default from measured long runs rather than taste, recording the measurement and the host in the plan, and keep the background shell the documented answer for genuinely unbounded work |
| Atomic publish changes file identity and breaks a watcher or a hardlink | Editors lose the file, or a hardlinked path stops tracking | Rename within the destination directory, preserve mode, and test against an existing file, a new file, a symlinked path, and a read-only parent |
| A denied credential path is bypassed by an alias | A probe reads the credential file through a symlink or a `@` alias | Resolve the denial against the canonical operation the execution path receives, which is the model `2026-09-05` already established for path authorization |
| Branch protection blocks the maintainer's own direct pushes | Release commits cannot land | Configure protection to require checks without blocking the release workflow's own tagged path, and verify by running one real release |
| Probes encode current behavior and pass vacuously | A probe never fails on a known-bad commit | Each probe must be observed failing at a commit where its finding is open before it is committed, per AGENTS.md test-first discipline |

## Verification

Run each unit in a scratch directory. Record the source commit, platform, and result.

Required focused checks.

- The reproduction script for goals 1 and 3, observed failing at `2afe5a517` and passing after the classifier change.
- Classifier tests for each registry entry, for a root-relative entry, and for a directory with no project resource.
- Classifier tests for an empty scope staying silent, for any rule or mode raising a prompt, and for malformed content raising a prompt. One case uses this repository's own tracked `.apex-code/permissions.json` shape.
- Classifier tests for the ancestor scope. A `.agents/skills` directory in a parent raises a prompt, the user-level `~/.agents/skills` does not, and a repository whose only resource is an ancestor entry is still classified correctly.
- A test that a loader receiving a parsed scope cannot observe a later write to the file it came from, which is the enforceable form of the one-read rule.
- A test asserting the classifier's set and the registry's set are equal, so neither can drift.
- Permission store tests for a trusted and an untrusted project at both the `project` and `local` sources, including a mode supplied by each.
- Delegation tests proving a project agent definition does not resolve for an untrusted project.
- MCP tests proving an eager project server does not start for an untrusted project.
- Resource-loader tests proving repository instruction files do not reach the system prompt for an untrusted project.
- Compile-level proof that `projectTrusted` cannot be omitted, by `npx tsgo --noEmit` over a call site with the argument removed.
- Credential-refusal tests for `read`, `grep`, `ls`, and `find` against the agent directory's `auth.json`, by absolute path, through a symlink, and through a project rule attempting to allow it.
- One probe per row of the 2026-09-05 confirmed-findings table, each observed failing before it is committed.
- Atomic publish tests for an existing file, a new file, a preserved mode, a symlinked destination, and a simulated crash between write and rename.
- `bash` timeout tests for the default firing, an explicit larger value, an explicit smaller value, and the message naming both escape hatches.
- A Windows startup test asserting the unsandboxed-required message names ADR 0005 and the next step.
- `npx tsgo --noEmit`, the narrowest relevant test files, then `npm test`, then `npm run check`.
- One required three-OS CI run on the finished branch, recorded by run id, after branch protection is enabled so the run is the gate rather than a report.

Branch protection itself is verified by observing a pull request that cannot merge while a required job is red, and by one real tagged release that still publishes.

## Rollout

Needs `docs/plans/2026-09-11-trust-classification-and-proof-integrity.md`, written when this spec is approved, because the work spans a security boundary, a repository setting, a table of probes whose outcomes are not known in advance, and three unrelated user-facing defects, and because the probe results need their own per-row status tracking.

Implement in the requested order. Goal 1 first and alone, because it is the live bypass and it should land as a small reviewable diff with its reproduction attached. Branch protection second, because every later claim in this spec cites a required CI run and that citation is worth nothing until the gate exists. The probes third, since they are what converts the remaining rows from assertions into checks. The criterion correction fourth, once the classifier work gives it something true to point at. The three small defects last, because none of them is a boundary and each is independently shippable.

Two decisions may prove irreversible enough to need an ADR, and neither is settled here. The first is making `projectTrusted` required across the SDK surface, which is a published-API break. The second is the default `bash` timeout value, which changes behavior for every existing user. Write the ADR before landing either, and cite it from this section.
