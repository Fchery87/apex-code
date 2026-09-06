# Spec: Security boundary remediation

**Status:** Active

## Metadata

| Field | Value |
|---|---|
| Author | Apex Code maintainers |
| Created | 2026-09-05 |
| Last updated | 2026-09-05 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility for existing session entries, provider configuration, and ordinary CLI behavior. It changes unsafe authorization outcomes, startup ordering, and release workflow behavior. Existing project permission files and policy files remain readable only when their source is trusted. SDK callers must choose an explicit sandbox contract if they need OS containment. |

## Executive summary

Apex Code has meaningful Linux process containment, but its trust, authorization, execution, and supervisor paths do not yet share one security contract. This change makes trust decisions apply before project-controlled startup, makes authorization use the same canonical operation that execution receives, and moves supervisor authority out of workspace-writable state. It also closes configured-command gaps, repairs platform escalation paths, and binds release publication to tested bytes.

## Context and motivation

The audit and architecture review in [`docs/research/2026-09-05-apex-code-audit-review-and-architecture-critique.md`](../research/2026-09-05-apex-code-audit-review-and-architecture-critique.md) found confirmed trust, permission, host-service, and release-integrity defects. Supporting probes and reports remain under `.apex-code/audit-2026-09-03/` and `.apex-code/audit-review-2026-09-05/`.

[`docs/adr/0005-sandbox-boundary-guarantees.md`](../adr/0005-sandbox-boundary-guarantees.md) defines the Linux and macOS process boundary and separates supervisor authority from child authority. [`docs/architecture/contracts.md`](../architecture/contracts.md) defines the canonical tool contract. The current implementation has not applied those boundaries consistently to project MCP startup, permission state, configured commands, supervisor state, and release publication.

This spec covers one remediation program because the findings share one cause. Security decisions are represented independently at several boundaries. Separate fixes would leave the system with more incompatible representations.

## Current state

| Area | Current behavior | Evidence |
|---|---|---|
| CLI startup | `requiresSandboxedChild()` scans raw arguments before the normal parser classifies option values and positional text. | `packages/coding-agent/src/core/sandbox/cli-launch.ts:17-21`, `packages/coding-agent/src/cli/args.ts:100-132` |
| Project trust | Trust controls several project loaders, but project permission state is constructed without the resolved trust decision. Eager project MCP can start before trust blocks it. | `packages/coding-agent/src/core/trust-manager.ts`, `packages/coding-agent/src/core/permissions/store.ts`, `packages/coding-agent/src/core/mcp/runtime.ts` |
| Path rules | Path matching and execution normalize different values. `@` aliases and symlink aliases can bypass target-specific rules. | `packages/coding-agent/src/core/tools/path-permission.ts`, `packages/coding-agent/src/core/tools/path-utils.ts` |
| Bash rules | Exact approvals collapse whitespace. Scoped denies do not reliably cover mixed or unsupported commands. | `packages/coding-agent/src/core/tools/bash.ts`, `packages/coding-agent/src/core/permissions/rules.ts` |
| Configured commands | Verification and formatting call `runPolicyCommand()` directly. Formatter scope is observed after execution instead of enforced during execution. | `packages/coding-agent/src/core/policy-executor.ts`, `packages/coding-agent/src/core/verification-lifecycle.ts`, `packages/coding-agent/src/core/formatter-lifecycle.ts` |
| Supervisor state | Terminal handoff state uses workspace-writable paths. Git credential execution accepts unsafe repository and protocol inputs. | `packages/coding-agent/src/core/sandbox/terminal-handoff.ts`, `packages/coding-agent/src/core/sandbox/rpc/git-credential-proxy.ts`, `packages/coding-agent/src/core/sandbox/git-credential-helper.ts` |
| Platform escalation | Linux does not project the advertised escalation socket. macOS writes the Seatbelt profile in workspace state and uses an overpowered escalation path. | `packages/coding-agent/src/core/sandbox/linux-backend.ts`, `packages/coding-agent/src/core/sandbox/macos-backend.ts` |
| Release | Workflow tests and publishes packed artifacts through separate steps. The verification helper trusts registry-supplied digests rather than retaining the pre-publication digest as an independent value. | `.github/workflows/release.yml`, `scripts/apex/packed-product-surface.mjs`, `scripts/apex/verify-published-release.mjs` |

## The problem

An untrusted repository can influence permission state and can start eager MCP code before trust has been resolved. A raw argument can make the launcher skip the OS sandbox for an ordinary session. A path or shell command can be authorized in one representation and executed in another. Configured verification and formatting can execute without the common permission decision. Supervisor services can turn workspace-controlled input into host-user authority. Release checks can prove that registry metadata is self-consistent without proving that the registry published the tarball that passed the local smoke test.

Passing focused unit tests does not prove complete mediation. The missing tests exercise public CLI, SDK, MCP, lifecycle, supervisor, and release paths together.

## Goals

- [ ] The public CLI parses arguments once and uses the typed result for metadata behavior, sandbox selection, and session construction.
- [ ] Untrusted projects cannot load project or local authorization grants, modes, eager MCP, hooks, or other project-controlled startup authority.
- [ ] The child cannot modify the authorization state used by its current or next permission snapshot.
- [ ] A canonical operation model supplies both authorization and execution for paths, Bash, configured commands, credential requests, and evidence.
- [ ] `@` aliases, symlink aliases, literal glob characters, unsupported shell grammar, mixed shell commands, and grammar-sensitive whitespace cannot bypass authorization.
- [ ] Every configured verifier and formatter enters the canonical execution permission path. A denied command does not spawn. An unresolved ask fails closed without a responder.
- [ ] Formatter execution cannot write outside its declared scope. Any incomplete scope observation or undeclared mutation produces failure rather than `passed`.
- [ ] Supervisor-owned state, policy snapshots, and platform profiles live outside child-writable roots and use safe file operations.
- [ ] Git credential helpers run without repository-controlled configuration, and protocol fields cannot change the authorized credential identity.
- [ ] Linux escalation works through the projected socket. macOS escalation uses a private profile and a minimal runner with no excess channels.
- [ ] Directory projections expose only the requested directory or a private copied projection.
- [ ] The SDK documents and enforces an explicit sandbox contract instead of implying OS containment.
- [ ] Publication uses the exact packed bytes that passed smoke tests. Verification checks the pre-publication digest and signed provenance identity.
- [ ] One release workflow remains authorized to publish artifacts.
- [ ] Public-boundary adversarial tests cover each finding and run in scratch directories.

## Non-goals

- [ ] This change does not claim protection from a compromised kernel, Bubblewrap, Seatbelt, proxy, dependency, administrator, or already-compromised host.
- [ ] This change does not make prompt injection disappear. Repository content remains model input and must be controlled through trust, permissions, and containment.
- [ ] This change does not add Windows OS sandbox enforcement. Windows remains a portability target until a separate supported backend exists.
- [ ] This change does not replace the canonical tool contract with a second classification system.
- [ ] This change does not add arbitrary shell-string execution to configured policies.
- [ ] This change does not create a universal verification or formatting command.
- [ ] This change does not preserve unsafe authorization behavior for compatibility. A project that relied on untrusted grants must receive an explicit trust decision.

## Proposed solution

| Component | Change | File areas |
|---|---|---|
| CLI command model | Parse CLI input once into a typed command result. Use it for metadata handling and sandbox launch. | `packages/coding-agent/src/cli/`, `packages/coding-agent/src/core/sandbox/`, `packages/coding-agent/src/cli.ts` |
| Trust context | Resolve trust before constructing project permission stores and MCP runtimes. Settings already gate hooks and policy loaders with the same resolved trust decision. Capture trusted project/local permission scopes once per store, while keeping managed policy and user scope live, so workspace writes cannot widen session authority. | `packages/coding-agent/src/core/trust-manager.ts`, `permissions/`, `mcp/`, `hooks/`, `settings-manager.ts` |
| Operation model | Define discriminated operation variants with canonical paths, parsed shell structure, command argv, credential identity, and execution facts. | `packages/coding-agent/src/core/permissions/`, `tools/`, `sandbox/` |
| Path authorization | Normalize once, resolve existing targets, handle new-write parents, separate exact rules from globs, and execute the authorized target. | `packages/coding-agent/src/core/tools/path-permission.ts`, `path-utils.ts`, filesystem tools |
| Bash authorization | Preserve exact shell structure, distinguish deny, allow, no-match, and unknown results, and prevent lower allows from erasing scoped denies. | `packages/coding-agent/src/core/tools/bash.ts`, `permissions/rules.ts` |
| Policy execution | Route verification and formatting through the canonical command authorization path. Enforce formatter scope during execution or use a restricted copy and promotion step. | `policy-executor.ts`, `verification-lifecycle.ts`, `formatter-lifecycle.ts` |
| Supervisor state | Use private supervisor directories, immutable child inputs, no-follow writes, and descriptor-relative operations where supported. | `sandbox/terminal-handoff.ts`, `sandbox/cli-launch.ts`, platform backends |
| Credential service | Run Git in a non-repository supervisor directory with repository configuration discovery disabled. Parse and validate protocol fields before authorization and serialization. | `sandbox/rpc/git-credential-proxy.ts`, `git-credential-helper.ts` |
| Platform escalation | Project only the Linux escalation socket. Move macOS profiles outside workspace state and use a minimal child runner. | `sandbox/linux-backend.ts`, `sandbox/macos-backend.ts` |
| SDK contract | Require an explicit `sandbox: "required" | "external" | "none"` choice or an equivalent typed contract. | `core/sdk.ts`, SDK documentation and tests |
| Release identity | A versioned release artifact record retains package name, version, absolute local tarball path, SHA-256, npm integrity, expected Git commit, signed-provenance subject, expected workflow identity, and standalone archive digests. It is written only after the packed identity check and the functional smoke both pass, and consumers validate the whole document (exactly the two owned packages, one release identity, exactly the six standalone archives). Publish only its tarballs. Verify downloaded bytes against its local digest, then use pinned npm 11.19.0 signature verification and decode the signed statement from `bundle.dsseEnvelope.payload` — npm exposes no decoded `statement` field — before checking the signed subject, repository, workflow path, tag ref, and commit. Registry `gitHead` is absent for a tarball publish and is not the commit authority. A real macOS packed smoke gates publication, and the standalone upload keeps one artifact root. Delete the legacy writer. | `.github/workflows/`, `scripts/apex/`, `.github/workflows/build-binaries.yml` |
| Regression suite | Add public-boundary tests with negative controls and evidence freshness labels. | `packages/coding-agent/test/`, `scripts/` |

The authorization seam remains the canonical tool contract and permission gate. The new operation model supplies the gate with typed facts. It does not create a second authorization engine. Evidence captures the facts held by the execution path.

## Deletion inventory

| Item | Type | Disposition |
|---|---|---|
| Raw pre-parse sandbox classification | behavior | superseded by the typed command result |
| Workspace-writable supervisor handoff state | behavior | retired in favor of supervisor-private state |
| Independent path normalization for authorization and execution | behavior | superseded by the canonical operation model |
| Boolean Bash matching for mixed and unknown grammar | behavior | superseded by structured match results |
| Direct policy lifecycle spawning outside the gate | behavior | superseded by canonical command authorization |
| Post-execution-only formatter scope checking | behavior | superseded by enforced scope or restricted-copy promotion |
| Registry-only digest comparison | behavior | superseded by comparison with a retained pre-publication digest |
| Legacy second release-writing workflow | workflow | removed or reduced to a non-publishing verification workflow |

No existing session format or provider API is removed. Unsafe permission outcomes change by design.

## Risks

| Risk | Signal | Response |
|---|---|---|
| A parser change alters ordinary CLI behavior | Public CLI compatibility tests fail | Keep one typed parse result and preserve genuine metadata commands as explicit variants |
| Trust gating blocks intended project configuration | Trusted and untrusted scratch-project tests diverge incorrectly | Make the trust decision visible in diagnostics and test each loader separately |
| Canonical path resolution mishandles new files or symlinks | Exact target tests fail on Linux or macOS | Test existing targets, new-write parents, replacement races, and no-follow execution |
| Shell parsing rejects useful commands | Existing approved-command tests fail | Keep the supported grammar explicit and require a new decision for unknown forms |
| Formatter confinement changes expected workflows | Declared-path formatter tests fail | Use a restricted copy and explicit promotion when direct confinement is not portable |
| Supervisor-private state breaks restart behavior | Session restart and escalation tests fail | Keep state lifecycle separate from workspace state and test crash cleanup |
| macOS behavior diverges from Linux | Native macOS tests fail | State platform guarantees separately and refuse unsupported modes |
| Release publication still repacks source directories | Mutation fixture shows a changed published digest | Make the packed tarball the only publish input |

## Verification

Run each unit in a scratch directory and record the actual source commit, runtime commit, platform, probe date, and result classification.

Required focused checks include:

- Public CLI tests for option values, positional text, `--`, genuine metadata commands, and sandbox startup.
- Trust tests for project permissions, local permissions, eager MCP, hooks, verification policies, and formatter policies.
- Gate-then-execute tests for canonical paths, `@` aliases, symlink aliases, literal glob characters, and new-write parents.
- Bash tests for direct, chained, redirected, quoted, escaped, unsupported, and grammar-sensitive commands.
- Verification and formatter tests that assert gate consultation, no spawn on deny, fail-closed ask behavior, enforced scope, and stale-result handling.
- Supervisor tests for policy projection, terminal handoff symlinks, Git configuration injection, credential protocol injection, and private state.
- Linux and macOS native escalation tests. Linux must verify the child can reach only the projected socket. macOS must verify the profile and minimal runner.
- Projection tests that prove sibling files remain unavailable.
- Release fixture tests that mutate the package directory after smoke testing and verify that publication still uses the tested tarball.
- Signed provenance verification that checks subject digest and workflow identity.
- `npx tsgo --noEmit`, focused package tests, `npm test`, `npm run check`, and the documentation lifecycle validator.

The full test suite is not green at the start of this work. The current baseline includes two flaky startup-session failures in the recorded audit run. The plan must track whether each repair changes that baseline.

## Rollout

Read the [implementation handoff](../../.apex-code/audit-review-2026-09-05/implementation-handoff.md) for the recommended order and entry checks. The plan tables remain the only task status records.

This change needs five plans because it spans the CLI, trust loaders, permission engine, tools, policy lifecycle, supervisor services, platform backends, SDK, release workflows, and tests. The plans are [startup and trust](../plans/2026-09-05-plan-startup-and-trust.md), [canonical authorization](../plans/2026-09-05-plan-canonical-authorization.md), [policy and supervisor authority](../plans/2026-09-05-plan-policy-and-supervisor.md), [platform boundaries](../plans/2026-09-05-plan-platform-boundaries.md), and [release integrity](../plans/2026-09-05-plan-release-integrity.md).

Create a separate ADR when implementation settles the canonical operation model, the SDK sandbox contract, or the release artifact authority. The ADR must cite this spec and replace the open choice with one settled decision.

Do not advertise a complete security boundary until the P0 and P1 acceptance tests pass on the supported platforms.

## Deletion inventory summary

This spec makes the deletion inventory explicit because the change removes duplicate and unsafe paths rather than adding another layer beside them. The detailed inventory above is authoritative.
