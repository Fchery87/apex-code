# Spec: Configured verification and formatting

**Status:** Landed

## Metadata

| Field | Value |
| --- | --- |
| Author | Apex Code maintainers |
| Created | 2026-09-01 |
| Last updated | 2026-09-04 |
| Roadmap phase | Product-surface follow-up |
| Tracking issue/PR | none |
| Compatibility posture | Preserves compatibility. No command runs by default, and existing edit, write, session, and tool results remain valid. Configured policies are additive. A policy that changes completion status or mutates files requires explicit configuration, permission, and documented failure semantics. |

## Executive summary

Apex Code can report post-mutation LSP diagnostics when a server is configured, but it has no safe, project-specific contract for verification commands or formatters. This spec adds opt-in named policies for checks and formatting. It does not run `npx tsc --noEmit`, `npx biome format --write`, or any other universal command by default.

Verification and formatting are separate operations with explicit permissions, timeouts, output bounds, working-directory rules, mutation reporting, and evidence. A failed check is visible and cannot be reported as a successful verified completion.

## Context and motivation

- `docs/research/2026-09-01-agentic-harness-capability-audit.md` recommends pre-completion verification and post-edit formatters, but its hardcoded command examples are unsafe universal defaults.
- `docs/specs/2026-09-01-tool-reliability-and-execution-budgets.md` owns test output, edit diagnostics, loop budgets, and workspace symbols.
- `docs/specs/2026-09-01-harness-correctness-and-workspace-state.md` owns compaction workspace state and checkpoint navigation.
- `docs/architecture/contracts.md` requires canonical permission, capability, context, and evidence declarations.
- `packages/coding-agent/src/core/agent-session-services.ts:349-355` already exposes post-mutation diagnostics when LSP is configured. This spec does not replace that path.

## Current state

Mutation tools write files and may request configured LSP diagnostics. No generic pre-completion verification policy or automatic formatter policy exists. The audit snippets use raw command execution and unconditional formatters, which would create trust, injection, latency, and mutation problems.

## The problem

A user may want Apex to run a project check before declaring work complete, or format only the files changed by an edit. The harness currently has no named policy that states which command is trusted, which paths it may access, whether it may mutate files, how it is approved, or how failure affects completion. Adding a universal command would be wrong across languages, package managers, operating systems, monorepos, and projects with untrusted configuration.

## Goals

- [ ] Define named verification and formatter policies with explicit executable/argv, working directory, path scope, permission class, timeout, output cap, and mutation policy.
- [ ] Require explicit user or trusted project configuration before a policy runs. The default remains disabled.
- [ ] Execute commands without unsafe shell-string interpolation. If shell syntax is supported, it must be a separately permissioned and clearly labeled capability.
- [ ] Apply cancellation, timeout, output, artifact, and process-tree rules consistent with existing command execution.
- [ ] Run formatters only on declared paths and report files changed by the formatter. A formatter must not silently modify unrelated paths.
- [ ] Make verification results visible in interactive and non-interactive modes and record bounded evidence with command identity, exit status, and artifact references.
- [ ] Define whether a verification failure blocks a completion claim, while preserving an explicit user choice to continue without verification when policy permits.
- [ ] Keep existing LSP diagnostics and tool contracts compatible.

## Non-goals

- [ ] Running `npx tsc --noEmit`, `npx biome format --write`, Prettier, rustfmt, dprint, or another command without configuration.
- [ ] Inferring a trusted command from `package.json`, shell aliases, or arbitrary project text without an approval policy.
- [ ] Running a project-wide check after every edit by default.
- [ ] Treating formatter output as proof that code is correct.
- [ ] Allowing a formatter to write outside its declared path scope.
- [ ] Replacing LSP diagnostics or the standalone `test` tool.
- [ ] Making verification a requirement for every user turn or every execution mode.

## Alternatives considered

- **Hardcode `npx tsc --noEmit`.** Rejected because many projects do not use TypeScript, the command may be absent, and it can execute project-controlled code.
- **Hardcode `npx biome format --write`.** Rejected because it mutates files, assumes a formatter, and can create unexpected diffs.
- **Execute a raw configured shell string.** Rejected as the default because shell strings enable injection and obscure the process tree and path scope. Structured argv is the default.
- **Use only LSP diagnostics.** Rejected because many projects have no LSP server and LSP diagnostics do not replace tests, builds, or project checks.
- **Use explicit named policies with permission and evidence.** Chosen because the user or trusted project can state the intended command and the harness can enforce its limits.

## Proposed solution

### 1. Policy shape

Define separate verification and formatter policy types. The final names may differ, but the fields and distinctions are required:

```ts
interface CommandPolicy {
  id: string;
  executable: string;
  argv: string[];
  cwd: "workspace" | string;
  pathScope?: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  maxOutputLines: number;
  shell: false;
  permission: "allow" | "ask" | "deny";
  trustedSource: "user" | "project" | "extension";
}

interface VerificationPolicy extends CommandPolicy {
  kind: "verification";
  blocksCompletion: boolean;
}

interface FormatterPolicy extends CommandPolicy {
  kind: "formatter";
  mutatesFiles: true;
  declaredPaths: string[];
}
```

A project policy is not trusted merely because it is in the repository. Loading it must follow the existing project trust and permission rules. The policy must use an executable plus argv by default. If `shell: true` is ever supported, it needs a distinct capability, explicit confirmation, and separate tests.

#### Settings ownership, precedence, and trust (settled 2026-09-03, VF.1 — ADR 0028)

Policies live under the optional `policies` settings key in user (global) and project
settings, versioned by `schemaVersion: 1`, with `verification` and `formatter` arrays.
The settings TypeScript shapes (`PolicyCommandSettings`, `VerificationPolicySettings`,
`FormatterPolicySettings`, `PoliciesSettings`) carry the loader-facing fields; the
runtime `CommandPolicy` above is stamped by the loader, which fills defaults
(`cwd` `"workspace"`, bounded `timeoutMs`/`maxOutputBytes`/`maxOutputLines`,
`permission` `"ask"`), rejects `shell: true` outright, and sets `trustedSource` from the
file the policy was loaded from.

- **Trust.** Project-scope policies load only after the existing project-trust decision; an untrusted project contributes zero policies.
- **Precedence.** Within a trusted project, a project policy ID replaces the user policy with the same ID. The resolver reads `getGlobalSettings()` / `getProjectSettings()` separately, never the merged view (same-key arrays replace wholesale there).
- **Extensions.** Extension-registered policies may only add new IDs; redefining a user or project ID is rejected at registration. Duplicate IDs within one source are a strict load error.
- **Permission ceiling.** The declared `permission` is a ceiling: session permission mode, sandbox policy, and the canonical tool contract still cap every invocation.
- **Defaults stay inert.** An absent `policies` key constructs no runtime and runs nothing; an unknown `schemaVersion` is a load error.

### 2. Execution and scope

Verification may run at an explicit user request, a configured post-turn boundary, or a configured extension hook. The policy names whether a failure blocks a completion claim or only adds a warning. It never silently changes a result from failed to passed.

A formatter runs only after an explicit edit/write or configured lifecycle point, and only for `declaredPaths` that remain inside `pathScope`. The executor records the before and after path set and reports unexpected changes. It must refuse path traversal, symlink escapes, and writes to undeclared files unless the policy explicitly and safely covers them.

Use existing process-tree termination and output artifact mechanisms. A timeout or cancellation must terminate descendants according to the command contract and report the actual outcome. Output is bounded for the model and retained as an artifact only under the existing privacy and retention policy.

### 3. Permission, trust, and evidence

A policy invocation is an `exec` capability and may also be `fs.write` for a formatter. The canonical tool contract projection remains the authority for permission and evidence classification. Project policies require trusted-project handling or an interactive approval step. A user-level policy may still be denied by session mode or sandbox policy.

Evidence includes policy ID, executable identity, normalized argv, working directory, exit/signal/timeout/cancellation status, duration, and bounded output/artifact references. It does not include complete output or unrestricted file contents. Formatter evidence also includes the declared and observed changed paths.

### 4. Completion semantics

The completion result must distinguish:

- verified success;
- verification failed;
- verification unavailable or not configured;
- verification cancelled or timed out; and
- user chose to continue without verification.

A blocking policy prevents a verified-completion status. It may either keep the run active for correction or return a structured failure that the model/user can act on. The choice is configuration, not a hidden fallback.

## Deletion inventory

| Item | Type | Disposition |
| --- | --- | --- |
| Hardcoded universal verifier commands | behavior | rejected. Replaced by named opt-in policies. |
| Hardcoded universal formatter commands | behavior | rejected. Replaced by scoped opt-in policies. |
| Raw unbounded command execution for verification | behavior | superseded by structured argv, permission, timeout, and output bounds. |

Nothing existing is removed. Existing LSP diagnostics and command tools remain available.

## Risks

- A trusted policy can execute arbitrary project code. Approval, permission, trust, and clear command display must precede execution.
- A formatter can modify unrelated files. Before/after path checks and declared scopes must detect and reject this.
- A command can spawn descendants or hang. Process-tree termination, timeouts, and cancellation must be tested.
- Output can contain secrets. Bounds, artifacts, and evidence exclusions must match existing policy.
- A verification result can become stale after later edits. Results must identify the observed path set or workspace observation and must not be presented as current after mutation.
- A check can be expensive or network-dependent. Policies need timeouts and user-visible execution state.

## Verification

| Contract | Evidence |
| --- | --- |
| Policy validation | Malformed policies, unsafe paths, shell attempts, missing executables, untrusted project policies, and invalid limits are rejected or require approval. |
| Verification | Scratch projects cover pass, fail, timeout, cancellation, signal failure, spawn failure, output truncation, descendant cleanup, path scope, and each completion status. |
| Formatting | Scratch projects cover declared-path mutation, unchanged output, formatter failure, undeclared-file mutation, symlink/path traversal, timeout, cancellation, and evidence. |
| Security | Tests prove no hardcoded command runs by default, no full output enters the session ledger, and denied policies execute nothing. |
| Compatibility | Existing LSP diagnostics, edit/write results, command output, sessions, and non-configured modes retain their current behavior. |

Run focused policy tests first, then `npx tsgo --noEmit`, `npm test`, `npm run check`, and `node scripts/validate-docs-lifecycle.mjs .`. All command and session tests must use scratch directories.

## Rollout

This needs a plan because it introduces a new trusted-command policy and formatter lifecycle. Create a plan after this Draft spec is approved. An ADR may be needed if the policy becomes a permanent settings or session-format contract.
