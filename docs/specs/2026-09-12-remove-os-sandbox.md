# Spec: Remove the OS sandbox; isolation becomes the operator's boundary

**Status:** Active

## Metadata

| Field | Value |
| --- | --- |
| Author | `fchery87` |
| Created | `2026-09-12` |
| Last updated | `2026-09-12` |
| Roadmap phase | `none (reverses Phase 2b, the only phase that built this)` |
| Tracking issue/PR | branch `feat/container-isolation-posture` |
| Compatibility posture | Clean break for the containment surface, and only for it. `--sandbox`, `--add-dir`, and `--permission-profile` stop being accepted flags, `network.*` and `sandboxProfiles` stop being read settings, and the SDK's `sandbox` option is removed. Session format, the permission rule model, project trust, and every provider and tool surface are untouched. A shim was declined because a flag named `--sandbox` on a binary with no sandbox is the exact class of false claim `2026-08-29-documented-surfaces-that-do-not-exist.md` was written to remove. |

## Executive summary

Apex Code stops shipping an OS sandbox. The supervisor and its platform backends, the egress allowlist proxy, the host-approval prompt, the sandboxed child launch, and the supervisor-mediated git credential path are deleted. A session becomes an ordinary local process running with the invoking account's permissions, which is what Prime Agent and Atomic do today. The README and the docs teach running the CLI inside a container or VM instead, because that is now the only place containment can come from. The permission gate is deliberately left alone.

## Context and motivation

This reverses [ADR 0005](../adr/0005-sandbox-boundary-guarantees.md) and retires the subject of five specs and six ADRs. It is not a refactor and should not be read as one.

The direct trigger is the escalation prompt. A session that requests a host outside `network.allowedHosts` stops and asks, because [core/sandbox/network-proxy.ts](../../packages/coding-agent/src/core/sandbox/network-proxy.ts) refuses the `CONNECT` and [host-approval.ts](../../packages/coding-agent/src/core/sandbox/host-approval.ts) renders the question from the supervisor. That prompt is not suppressible from inside a session by design. `bypassPermissions` governs the tool gate and [core/sandbox/profiles.ts](../../packages/coding-agent/src/core/sandbox/profiles.ts) states the separation outright, so the two layers cannot be conflated by accident and cannot be conflated into a fix. Every route to silence the prompt either edits a global settings list or removes the boundary.

Three harnesses were read as prior art on 2026-09-12.

- **Prime Agent** ships no boundary and says so in three places. Its `packages/coding-agent/docs/architecture.md` records that workers and kernels are "separate processes for lifecycle and failure containment, not security sandboxes", and its README instructs users to run autonomous work "inside a devcontainer, VM, or remote development machine".
- **Atomic** is more explicit still. `packages/coding-agent/docs/security.md` opens with "Atomic does not include a built-in sandbox", states that project trust "is not a sandbox", and carries a warning that tools "run with your user permissions". Its `docs/containerization.md` then offers Gondolin, plain Docker, and OpenShell as the three ways to get containment.
- **Codex** does enforce a boundary, but it exposes the choice. `network_access` is a config boolean, `danger-full-access` is reachable from `/permissions`, and `approvals_reviewer = "auto_review"` routes eligible prompts to a reviewer agent.

The pattern across all three is that a harness asks a human about a host only when it both enforces the boundary and refuses to let the session widen it. Codex lets the session widen it, so the friction is configured away once. Prime Agent and Atomic never enforce one, so there is nothing to ask about.

Two facts about this repository's own position belong here rather than in Risks.

[ADR 0014](../adr/0014-sole-maintainer-production-operations.md) records sole-maintainer production operations. The boundary is the single most expensive thing in this repository to keep honest. It carries two platform backends, an AppArmor `sysctl` workaround in CI, and a macOS guarantee that Phase 2b itself recorded as "categorically weaker than Linux's". The 2026-09-05 remediation spec and the audit under `.apex-code/audit-2026-09-03/` both exist because real escape paths were found after the fact.

The boundary has also broken an unrelated subsystem once already. The 2026-08-20 follow-up records that whole-CLI launch repoints `HOME` and the agent directory into the workspace, which silently disabled user-scope skill discovery. Repairing that took nine tasks.

Deleting Apex-only code also lowers fork divergence rather than raising it, so [ADR 0003](../adr/0003-upstream-merge-cadence.md)'s merge ceiling is not at risk.

## Current state

Containment is the default for every command that can construct a session. `requiresSandboxedChild()` in [core/sandbox/cli-launch.ts](../../packages/coding-agent/src/core/sandbox/cli-launch.ts) is `command.kind === "session"`, and [cli.ts](../../packages/coding-agent/src/cli.ts) line 112 takes the sandboxed launch branch whenever `sandboxMode !== "danger-full-access"`. With no flag, `sandboxMode` is `undefined`, so the branch is taken. `enforced` is the default.

`buildSandboxedCliLaunch()` in the same file repoints `HOME`, `TMPDIR`, `APEX_CODE_CODING_AGENT_DIR`, `APEX_CODE_CODING_AGENT_SESSION_DIR`, and all four `XDG_*` directories into `workspace/.apex-code/`, allowlists the child environment, and projects the host's two permission scopes through a supervisor-owned snapshot file.

| Surface | Size | Location |
| --- | --- | --- |
| Sandbox sources | 25 files, ~4,453 lines | `packages/coding-agent/src/core/sandbox/` |
| Sandbox tests | 35 files, ~6,854 lines | `packages/coding-agent/test/sandbox/`, plus two root-level files |
| Files importing it from outside | 6 | `cli.ts`, `modes/interactive/interactive-mode.ts`, `core/permissions/store.ts`, `core/settings-manager.ts`, `core/package-manager.ts`, `core/tools/web-fetch.ts` |
| Files naming it in comments or types | ~18 | including `core/sdk.ts`, `core/tools/bash.ts`, `core/mcp/connector.ts`, `core/delegation/runtime.ts`, `utils/tools-manager.ts` |
| ADRs that mention it | 14 | six centrally, see the deletion inventory |

The current state is Apex Code's own work, not upstream Pi's. Pi ships none of this, which is the premise [Phase 2](../roadmap.md) was built on.

## The problem

Five concrete costs, in the order they bite.

**A prompt nobody can suppress from where they are.** `docs/settings.md` records that a credential for the search backend is added to the allowlist automatically, and enforces exactly that. Everything else asks. A repository that fetches a font or a JavaScript CDN stops the session on its first build, and the answer "add it to global settings" is the answer the prompt already gives, which is why the prompt reads as noise rather than as a decision.

**A guarantee that is recorded as weaker than it reads.** ADR 0005's amendments state that the macOS boundary is categorically weaker, and that Apple Events, Launch Services, and code-signing behavior for a distributed binary remain unaddressed. A boundary whose own record carries unresolved holes is a boundary users will over-trust.

**A repair history rather than a clean record.** Seven units of delegation and escalation work, a nine-task skill-discovery repair, a remediation spec, and a third-party audit all exist to keep the boundary honest. Each was needed. None of them is a step toward the boundary being cheap.

**A cost concentrated on one maintainer.** Per ADR 0014 this is a one-person operation. Platform-divergent security code with two backends and a CI workaround is the worst possible shape of work for that constraint.

**Friction that the alternatives show is optional.** Three comparable harnesses either do not enforce a boundary or let you widen it in-session. A user comparing them sees Apex asking a question the others never ask.

## Goals

- [ ] `--sandbox`, `--add-dir`, and `--permission-profile` are absent from `--help` and rejected as unknown flags.
- [ ] No file under `packages/coding-agent/src` defines or imports the supervisor, a platform backend, or the egress proxy.
- [ ] `network` and `sandboxProfiles` are absent from the settings schema, and `getNetworkSettings()` and `getSandboxProfiles()` no longer exist.
- [ ] `createAgentSession()` accepts no containment option and reports no containment claim.
- [ ] A session writes outside the workspace and reaches a host that no longer appears in any allowlist, both without a prompt.
- [ ] `npm run check` and `npm test` pass with the sandbox suites deleted rather than skipped.
- [ ] A structural test fails when any of the deleted symbols reappears, so a partial deletion cannot pass.
- [ ] The README and `docs/user-guide.md` teach container or VM isolation in place of the removed section, and name no guarantee the code no longer provides.

## Non-goals

- [ ] **The permission gate stays.** ADR 0004's rule model, its eight-source precedence, and its five modes are a separate layer. It runs in-process, it is platform-independent, it costs a fraction of the boundary to maintain, and it is the layer that makes every tool's declared capabilities mean something. Removing it is a different spec with a different argument, and this spec does not pre-decide it.
- [ ] **Project trust stays.** Upstream Pi's input-loading guard is what stops a cloned repository from changing settings and extensions before you approve it. `CONTEXT.md` already records that it "is not a sandbox and not a permission system". The active trust-classification work continues unchanged.
- [ ] **No container runtime is shipped.** Documentation and at most a documented example image. Prime Agent and Atomic both stop at teaching the pattern, and building a container orchestrator would recreate the maintenance burden this change removes.
- [ ] **The session format does not change.** ADR 0006's migration guarantee is untouched. Nothing in the boundary writes session state.
- [ ] **No compatibility shim.** A removed flag becomes an unknown flag. Accepting `--sandbox` and ignoring it would leave a security-shaped word in the CLI of a binary with no security boundary.
- [ ] **Skill discovery does not regress.** The sandbox is the reason the projection exists. Removing the boundary restores host-side discovery, and ADR 0021's name-only catalog stays because it is a token-budget decision, not a containment one.

## Proposed solution

| Component | Change | File(s) |
| --- | --- | --- |
| Sandbox subsystem | Delete the directory and its RPC channel | `packages/coding-agent/src/core/sandbox/` |
| CLI launch | Drop the sandboxed branch; sessions run in-process | `cli.ts`, `cli/args.ts` |
| Settings schema | Delete `network`, `sandboxProfiles`, and their getters | `core/settings-manager.ts` |
| SDK contract | Delete the `sandbox` option and its diagnostics | `core/sdk.ts` |
| Credential path | Delete the supervisor channel; git uses host credentials again | `core/sandbox/rpc/*`, `core/package-manager.ts` |
| Remaining importers | Remove the comments, types, and branches that name the boundary | 6 files, listed in Current state |
| Documentation | Replace the boundary sections with container guidance | `README.md`, `packages/coding-agent/README.md`, `docs/user-guide.md`, `packages/coding-agent/docs/settings.md`, `docs/architecture/overview.md` |
| Guarantees | Record the new posture and supersede the old ADRs | `docs/adr/0032-*.md`, `docs/adr/0004`, `CONTEXT.md` |

The load-bearing seam this change touches is startup, not `beforeToolCall`. `beforeToolCall` and `ruleContent` are untouched, so ADR 0010's invariants and ADR 0004's precedence hold without amendment. What changes is that the child process stops existing, which means `transformContext` and the tool gate now run in the process the user started.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| `packages/coding-agent/src/core/sandbox/` (25 files, ~4,453 lines) | code | removed |
| `ParsedCliCommand.sandbox`, `--sandbox` (`cli/args.ts:55`, `:261`) | config | removed |
| `--add-dir` and `ParsedCliCommand.addDir` (`cli/args.ts:54`, `:248`) | config | removed |
| `--permission-profile` and `sandboxProfiles` (`cli/args.ts:255`, `settings-manager.ts:277`) | config | removed |
| `network.allowedHosts`, `network.allowDefaultHosts`, `NetworkSettings`, `getNetworkSettings()`, `getSandboxProfiles()` (`settings-manager.ts:191`, `:270`, `:1112`) | config | removed |
| `requiresSandboxedChild()` and the sandboxed launch branch (`cli.ts:103-165`) | code | removed |
| `SANDBOX_ENFORCEMENT_MARKER_VARIABLE`, `POLICY_SNAPSHOT_PATH_VARIABLE`, `writeSupervisorPolicySnapshot()` | code | removed |
| SDK `sandbox: "required" \| "external" \| "none"`, `sandboxContract`, `sandboxDiagnostic` (`core/sdk.ts`) | code | removed |
| `test/sandbox/` (35 files, ~6,854 lines), `test/restore-sandbox-env.test.ts`, `test/sdk-sandbox-contract.test.ts` | test | removed |
| Bubblewrap install and the AppArmor `sysctl` step | config | removed from `.github/workflows/ci.yml` |
| Host approval prompt, refusal message, and violation store | behavior | retired |
| Git credential release prompt and supervisor-mediated credential path | behavior | retired |
| `danger-full-access` banner, confirmation, and `full-access.ts` | behavior | retired |
| `README.md` OS sandbox section, escalation prose, and profile example | doc | replaced by container guidance |
| `docs/user-guide.md:36-38`, `:74-77` | doc | rewritten |
| `packages/coding-agent/README.md:4`, `:51-55` | doc | rewritten |
| `docs/architecture/overview.md:51` | doc | amended |
| `packages/coding-agent/docs/settings.md` network and profile rows | doc | removed |
| ADR 0005, 0015, 0016, 0023, 0024, 0031 | doc | superseded by ADR 0032 on implementation |
| ADR 0004 | doc | amended to drop the layer beneath the gate |
| ADR 0008, 0030 | doc | audited, amended only where they name the boundary |
| ADR 0001, 0003, 0014, 0018, 0028 | doc | unaffected, incidental mentions only |
| Specs `2026-08-12-os-sandbox`, `2026-08-20-sandbox-skill-projection`, `2026-08-22-supervisor-mediated-credential-writes`, `2026-08-28-sandbox-delegation-and-escalation`, `2026-09-05-security-boundary-remediation` | doc | `Superseded` on implementation |
| Spec `2026-09-08-windows-ci-path-roots` (active) | doc | audited, its sandbox assertions fold into this work and its root-traversal fix survives |
| `.apex-code/audit-2026-09-03/` escape-path findings | doc | moot, kept as history |
| `sandbox-agent/`, `sandbox-sessions/`, `sandbox-state/` under the agent directory | config | orphaned on existing installs, removed on next start or named in the release note |

Prose that claims containment must not survive the code. The finding from `2026-08-29-documented-surfaces-that-do-not-exist.md` applies directly, and a claim of containment after the boundary is gone fails harder than a missing `/help` command.

## Risks

**A user who relied on containment loses it silently on upgrade.** The README currently advertises the boundary as a feature. The signal is a user report, and the mitigation is a release note that says what stopped, in the release that removes it. Anything less makes this a security-relevant surprise, which is the one failure mode worth spending a release note on.

**`git push` starts working without a release.** The supervisor-mediated credential path exists so a session pushes only after a human releases a host credential. Removing it restores ordinary host git behavior. That is a capability gain inside the session and it must be named in the release note rather than discovered.

**The workspace write boundary disappears.** Writes outside the workspace succeed after this change. `--add-dir` exists to widen that boundary and becomes meaningless, which is why it is deleted rather than kept.

**A partial deletion leaves something still claiming containment.** The dangerous shape is a leftover marker, flag, or settings key that reads as enforcement. The signal is the structural test in Verification. Without that test a partial deletion passes typecheck, because deleting a leaf that nothing imports still compiles.

**Reversal becomes expensive.** Rebuilding this is a Phase-2-sized effort. The mitigation is that the deleted specs, ADRs, and code stay in git history, and the six superseded ADRs stay in the repo marked `Superseded` rather than deleted, so the reasoning survives its implementation.

**Prior art is not a proof.** Prime Agent and Atomic are research and eval harnesses whose operators are expected to supply a container. Apex Code is a distributed product for a developer's own machine. The trade is accepted here, and the honest statement of it is that this moves the safety claim from the harness to the user's own environment.

## Verification

**Unit.** `npx tsgo --noEmit` clean. `npm test` green with the sandbox suites deleted, not skipped. A structural test asserts the absence of the deleted surface, and that test is the one that makes a partial deletion fail. It checks the CLI flag list, the settings schema keys, the SDK option, and a source scan for the removed symbol names.

**Live.** Run a session inside a container, with no host credential store mounted. Confirm all four, with the commands pasted in the pull request.

- A build that fetches a public CDN host completes with no prompt. A prompt appearing is a fail.
- A write to a path outside the workspace succeeds.
- `git push` uses the container's own credentials and no supervisor prompt appears.
- `--sandbox`, `--add-dir`, and `--permission-profile` each exit non-zero with an unknown-flag error, and `--help` lists none of them.

**Perf.** No metric moves by design, so this is a guard rather than a target. Probe `test/streaming-render-bench.ts` at trunk and at the head back to back on an idle host, and read a uniform multiple across scenarios the change cannot reach as contamination rather than as a regression, per `2026-09-07-ember-workflow-completion.md`. Separately confirm the replay corpus still produces byte-identical metrics across two consecutive runs, since nothing in this change touches the session format and any movement there is a real defect.

**Not verified by this change.** macOS enforcement behavior, because there will be none. Windows, which already had no backend.

## Rollout

Needs `docs/plans/2026-09-12-remove-os-sandbox.md`, because it spans roughly twenty source files, three test suites, six ADRs, five specs, and a CI workflow. The slices should be ordered so each one leaves the tree green and the claim true.

1. The structural absence test, written first and failing, so the deletion has a checker before it has a deletion.
2. The settings schema and the CLI flags, with the docs that name them.
3. The launch path, moving sessions in-process.
4. The sandbox directory, its RPC channel, and its tests.
5. CI, then README and the user guide.
6. ADR 0032 superseding 0005, 0015, 0016, 0023, 0024, and 0031, plus the 0004 amendment, plus the `Superseded` flips on the five specs.

The superseding ADRs belong to the implementation, not to this spec. Nothing is marked `Superseded` today, because every one of those documents still describes code that ships. They become false at the same commit that deletes the code, and not before.

One decision inside this belongs in an ADR of its own if it turns out to be contested during implementation. Whether the credential handoff is deleted outright or replaced with a narrower prompt is currently settled as deleted, on the ground that a boundary that no longer exists cannot own a credential.
