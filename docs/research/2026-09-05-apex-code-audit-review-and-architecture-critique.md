# Apex Code audit review and architecture critique

**Status:** Research record

**Date:** 2026-09-05

**Scope:** Read-only review of `.apex-code/audit-2026-09-03/report.md`, its supporting reports and reproductions, the current repository source, and public first-party documentation for comparable coding agents.

**Audited checkout:** `2477e594ef1479d1cb4467f0bc50c2e14fcd3e00`

**Current review checkout:** `1964612833cddbf89e4ad61fa0921e8b42f488cc`

**Review artifacts:** `.apex-code/audit-review-2026-09-05/`

## Executive judgment

The audit is substantially correct.

Apex Code has real Linux containment. It also has several useful fail-closed paths. That is not enough to claim that project trust, permissions, sandboxing, configured commands, and supervisor services form one reliable security boundary.

The main problem is architectural. The same operation is interpreted several times by different components.

- The launcher classifies raw arguments.
- The parser classifies them again.
- The trust manager decides which project files load.
- The permission store loads authorization state separately.
- Tool-specific matchers interpret paths and shell commands.
- Policy commands run through a separate lifecycle path.
- Supervisor services apply their own protocol and filesystem rules.

Each component looks reasonable in isolation. The composition is not reliable.

No finding merits an unconditional Critical rating. The High findings have stated prerequisites such as a malicious repository, a writable workspace, a released credential host, or a permissive rule.

## Current-source review

The audited application source is unchanged for the reviewed security paths in the current checkout. The current local changes affect model-data hydration and were preserved.

The review artifacts are stored under:

```text
.apex-code/audit-review-2026-09-05/
```

The review used these classifications:

- `static-current`
- `runtime-audited-checkout`
- `runtime-current`
- `helper-only`
- `unverified-platform`

Retained runtime probes from the original audit are historical evidence for the audited checkout unless a report says otherwise. Current source inspection confirms the affected paths remain present. A probe that exercises only a helper is not treated as proof of a complete public flow.

## Confirmed findings

| Area | Judgment | Confidence |
|---|---|---|
| Project permission files bypass trust | Real defect | Confirmed statically |
| A write-capable session can rewrite authorization state | Real defect | Confirmed statically and supported by the retained probe |
| Eager project MCP runs while the project is untrusted | Real defect | Confirmed by the corrected public-session probe |
| Raw CLI argument scanning can skip sandbox startup | Real defect | Confirmed statically and supported by the retained probe |
| `@` path aliases bypass path rules | Real defect | Confirmed statically and supported by the retained probe |
| Symlink aliases bypass target-specific path rules | Real defect | Confirmed statically and supported by the retained probe |
| Mixed Bash commands can defeat scoped denies | Real defect | Confirmed statically and supported by the retained probe |
| Quoted whitespace is lost in exact Bash approvals | Real defect | Confirmed statically and supported by the retained probe |
| Generated literal path grants can become globs | Real defect | Confirmed statically and supported by the retained probe |
| Verifier commands bypass the canonical permission gate | Real defect | Confirmed by source and the corrected public-session probe |
| Formatters can mutate undeclared files and still report success | Real defect | Confirmed by source and the corrected public-session probe |
| Git credential helpers can execute repository configuration on the host | Real defect | Conditional on credential release |
| Credential protocol input permits host confusion | Real defect | Conditional on an already authorized credential path |
| Supervisor state writes follow workspace symlinks | Real defect | Confirmed by source and the retained scratch probe |
| Custom host policy can be lost during sandbox launch | Real defect | Confirmed by source and the retained projection probe |
| Linux escalation socket is missing inside the child | Real defect | Fails closed, but the feature is broken |
| macOS Seatbelt profile is workspace-writable | Serious race | Static only on this machine |
| macOS escalation retains excess channels | Serious design defect | Static only on this machine |
| Directory projections expose parent siblings | Real overprojection | Confirmed statically and supported by the retained builder probe |
| Release publication is not clearly bound to tested bytes | Valid release-integrity concern | Confirmed from the audited workflow |

## Findings and repairs

### Project trust and authorization state

`FilePermissionRuleStore` constructs project and local backends from `cwd/.apex-code` without receiving the resolved trust decision. The trust detector does not treat these permission files as protected project resources. An untrusted checkout can therefore supply a project mode or allow rule.

A write-capable `acceptEdits` session can also write `.apex-code/permissions.local.json`. The next permission snapshot reads that file and can grant broader permissions. A restriction on the store's own `apply()` method does not protect the file from the ordinary write tool.

The smallest repair is to resolve trust before constructing the permission store. Exclude project and local grants and modes while untrusted. Keep authorization state outside model-writable workspace paths. A deny-only project representation could be supported later, but it must be a separate type.

The project policy loader itself is trust-gated. The narrower defect is that some lifecycle executors run a loaded policy without entering the canonical permission gate.

### Eager MCP

A repository-supplied eager MCP command can execute while the project is untrusted. The corrected public-session probe used `projectTrusted: false`, no tools, and a gate that would deny calls. The MCP marker was created and the permission gate was not consulted.

Eager MCP is a trust-gate defect. It is not automatically an OS escape. The impact becomes larger when the raw CLI classifier also starts the session outside the sandbox.

The runtime must resolve trust before starting project MCP. The same rule must apply to project hooks and other project-controlled startup code.

### CLI sandbox selection

`requiresSandboxedChild()` scans raw tokens for metadata flags before the normal parser handles option values and `--` tail arguments. The public launcher can therefore treat ordinary session text as metadata and call `main()` on the host.

Examples include:

```text
--print -- --help
--system-prompt --version --mode rpc
--append-system-prompt --help --mode rpc
```

The repair is to parse once. Use one typed command result for metadata behavior, sandbox selection, full-access confirmation, and session creation.

### Path authorization

Path permission matching and execution use different representations. Matching does not remove the `@` prefix that execution removes. Lexical matching also allows a symlink alias to bypass a target-specific deny.

The repair is one canonical path operation before authorization. It must handle `@` prefixes, Unicode whitespace, relative and absolute paths, existing symlink targets, non-existent write targets, parent resolution, and workspace containment.

For existing targets, authorize the resolved target. For new targets, authorize the resolved parent and final name. Use no-follow operations during execution so the path cannot change between authorization and the write.

Generated exact-path grants must not reuse the user glob grammar. Use a tagged representation such as:

```ts
type PathRule =
	| { kind: "exact"; path: CanonicalPath }
	| { kind: "glob"; pattern: string };
```

### Bash authorization

`normalizeSegment()` collapses all whitespace. An exact approval for a harmless shell command can therefore match a variant containing a quoted newline that executes an additional command.

The repair should preserve parsed token and operator structure for exact approvals. If the grammar cannot represent a command safely, the system must retain an unresolved result and require a new decision.

A scoped deny for `touch:*` does not match a mixed command such as `echo ok; touch denied` under the current all-segments matcher. A lower blanket allow can then authorize the call. Unsupported grammar has the same problem.

Use a richer result instead of a Boolean:

```ts
type BashMatch =
	| { kind: "allow-match" }
	| { kind: "deny-match"; segment: BashSegment }
	| { kind: "no-match" }
	| { kind: "unknown"; reason: string };
```

Define precedence over those results. Do not reuse an allow matcher to implement deny semantics.

### Verification and formatting

Configured verification and formatter policies are intended to be execution capabilities. The specification says they require explicit permission, trust, timeout, output bounds, and scope enforcement.

The implementation calls `runPolicyCommand()` directly. It does not consult the canonical permission gate.

The corrected public-session probe showed:

```text
permission gate calls: 0
denied verification: returned verified
formatter undeclared write: persisted
formatter status: passed
```

`declaredPaths` is intended to enforce filesystem scope. The implementation observes changes after execution. It does not confine the process during execution.

The severity should distinguish permission values:

- `permission: "deny"` being ignored is High. An explicit deny must prevent spawning.
- `permission: "ask"` being ignored is Medium. The configured command is explicit and trusted, but the promised prompt is missing.

The repair is to route every configured command through the canonical execution authorization path. A denied policy must spawn nothing. An unresolved ask must fail closed when no responder exists. A formatter that changes an undeclared file must fail rather than return `passed`.

A Git worktree is not formatter confinement. The formatter needs enforced path scope or an isolated copy.

### Supervisor services

Git credential lookup runs `git credential fill` without a supervisor-owned non-repository working directory. Repository configuration can define a shell helper that executes as the host user after the user releases a reachable credential host.

The credential protocol is newline-delimited, but fields are not validated strictly enough. Newline injection can change the credential identity after authorization checks a different host.

The repair is to run Git from a private, non-repository directory with repository configuration discovery disabled. Validate protocol fields before authorization and serialization. Reject carriage returns, newlines, NUL bytes, invalid schemes, and ambiguous hosts.

Supervisor terminal handoff state is written inside workspace-writable state and can follow a symlink. Supervisor-owned state must move outside child-writable roots. Use private directories, restrictive permissions, no-follow writes, and descriptor-relative operations where supported.

The custom policy path projection defect is real, but it is Medium rather than High. It can remove an expected host policy when the host relies on a custom path. It does not automatically grant access unless the missing policy contained the relevant denial.

### Platform-specific sandbox findings

The Linux escalation socket is created and advertised to the child but is not projected into the Bubblewrap child. The feature fails closed and is nonfunctional. The fix is to project only the intended socket and test the real production approval path.

The macOS Seatbelt profile is written below workspace state and then passed to `sandbox-exec`. Since the workspace is child-writable, profile substitution is structurally possible between write and read. Native macOS execution was not available for this review.

The macOS escalation path recursively creates a full backend. It can retain network, credential, terminal, and other channels that the minimal escalation contract excludes. Replace it with a minimal runner and verify it on native macOS CI.

Directory projections bind parent directories. A requested skill directory can expose sibling files. Mount the exact requested directory or create a private copied projection.

### SDK boundary

The SDK path without an OS sandbox is an embedding contract, not itself a sandbox escape. ADR 0005 scopes OS containment to the CLI supervisor.

The SDK should document this explicitly and expose a clear choice such as:

```ts
sandbox: "required" | "external" | "none"
```

A `required` mode should fail when the caller has not provided a supported supervisor. The default should not silently imply OS containment.

## Release integrity

The release workflow tests local packed tarballs but must be reviewed to ensure publication uses the exact same bytes.

The retained comparison probe accepted fabricated self-consistent metadata:

```text
metadataProblems: []
tarballProblems: []
```

This does not prove a registry compromise. It proves that registry-supplied digests are not independent proof that the published bytes equal the pre-publication tarball tested locally.

The release process should:

1. Build the package once.
2. Pack the exact tarball.
3. Record its SHA-256 and integrity value.
4. Smoke-test that tarball.
5. Publish that exact tarball.
6. Fetch the published tarball.
7. Compare it with the pre-publication digest.
8. Verify the signed provenance subject digest and workflow identity.
9. Publish standalone artifacts from the same immutable release input.
10. Remove or disable every second release authority.

The inherited `build-binaries.yml` remains a second release-writing authority. It expects obsolete `pi-*` archive names while the active workflow produces `apex-code-*` archives. A broken release writer is still unsafe as a second authority.

## Competitive and market context

The public-source research is date-qualified. It supports capability comparisons, not September 3 binary behavior, market size, adoption, or market share.

The closest security baseline is Codex, which publicly documents trust-gated project configuration, managed requirements, local sandboxing, and network-off behavior.

Claude Code documents broad workflow support and mature permission modes, but its sandbox fallback behavior is weaker than Apex's intended fail-closed startup. Apex should not copy that fallback model.

Gemini CLI documents sandbox support, trusted folders, and OpenTelemetry integration. This shows that enterprise operations and observability matter alongside local execution.

OpenCode documents provider flexibility but no sandbox. Provider independence alone is not a sufficient security differentiator.

The strongest target is security-conscious software teams that run local or self-hosted agents across multiple model providers and need a reviewable action ledger. The useful product promise is:

> Apex Code runs local coding agents against unfamiliar repositories with explicit project trust, enforceable local policy, provider choice, and source-captured evidence of what ran.

The project should not market perfect containment, unstoppable permissions, or complete MCP governance until the findings above are repaired and tested at public boundaries.

The action ledger is a strong potential product feature. It should record the executable, normalized arguments, policy source, trust state, sandbox mode, exit status, changed paths, and artifact digest.

Useful market validation measures include:

- time to first provider turn;
- time to configure a trusted repository;
- prompts per normal task;
- adversarial trust-test coverage;
- percentage of actions reconstructible from the ledger;
- provider-switch success rate;
- release digest and provenance verification success.

Do not publish market-size or adoption claims without direct evidence.

## Recommended delivery order

### P0. Close trust and startup gaps

1. Parse CLI arguments once.
2. Use the typed parse for sandbox selection and metadata behavior.
3. Trust-gate project permissions, local permissions, MCP, hooks, and other project loaders.
4. Prevent eager MCP from starting before trust is resolved.

### P1. Make authorization and execution share one operation

Use one canonical operation model for paths, Bash commands, configured commands, credential requests, and evidence. The model must contain the exact facts used by execution.

### P2. Restore complete command mediation

1. Route verification through the canonical permission path.
2. Route formatting through the canonical permission path.
3. Make deny spawn nothing.
4. Make ask fail closed without a responder.
5. Enforce formatter paths during execution.
6. Return failure when scope observation is incomplete or an undeclared mutation occurs.

### P3. Remove supervisor-owned state from child-writable locations

Move terminal handoff state, policy snapshots, and launch profiles into private supervisor-owned directories. Use no-follow and descriptor-relative writes. Validate credential protocol fields before authorization and serialization.

### P4. Repair platform-specific escalation

1. Project the Linux escalation socket into the child.
2. Keep Linux escalation narrowly scoped.
3. Move macOS Seatbelt profiles outside workspace state.
4. Replace recursive macOS escalation with a minimal runner.
5. Verify both platforms natively.

### P5. Bind release publication to tested bytes

Publish the exact tarball that passed smoke tests. Compare the registry download with a digest captured before publication. Verify the signed provenance subject digest and workflow identity. Remove the legacy release-writing workflow.

## Acceptance tests

Each repair should include a failing public-boundary test before the implementation and a focused green test afterward.

1. Start the real public CLI with metadata-looking positional text and option values. Assert that an ordinary session selects the sandbox. Assert that genuine `--help` and `--version` remain metadata commands.
2. Start a scratch project with `projectTrusted: false` and project permission files. Assert that project grants and modes are ignored. Trusting the project must enable them.
3. In `acceptEdits`, attempt to write both permission files and a symlink to one. Assert that authorization does not change on the next snapshot.
4. Start eager project MCP in an untrusted project. Assert that it does not execute.
5. Gate and execute `read({ path: "@secret.txt" })` under a deny for the canonical target. Assert that the target remains unreadable.
6. Gate and execute a symlink alias under a deny for its resolved target. Assert that the target remains unreadable.
7. Apply a scoped `touch:*` deny with a lower blanket allow. Test direct, chained, redirected, quoted-newline, and unsupported commands. Assert that `touch` never executes.
8. Approve an exact shell command. Alter quoted whitespace, newline, comments, and escapes. Assert that the altered command does not reuse the approval.
9. Approve literal paths named `*.txt`, `[a].txt`, and names containing Unicode spaces. Assert that only the exact targets are allowed.
10. Configure a denied verifier. Assert that it spawns nothing and cannot return `verified`.
11. Configure a formatter for `allowed.txt` that writes `unrelated.txt`. Assert that the formatter is blocked or returns failure and that the undeclared write does not persist.
12. Configure a custom host policy. Assert that the effective policy inside the child matches the supervisor's resolved policy.
13. Configure a hostile Git credential helper in a scratch repository. Assert that host configuration is not executed by the supervisor.
14. Send credential fields containing newline, carriage return, NUL, invalid schemes, and ambiguous hosts. Assert that the request is rejected before authorization or serialization.
15. Replace supervisor terminal state with a symlink. Assert that no write reaches the symlink target.
16. On Linux, request escalation through the production child. Assert that approved and denied paths behave as documented.
17. On macOS, race profile creation and replacement. Assert that the launched child uses only the intended profile.
18. Mutate the package directory after smoke testing and before publication in a release fixture. Assert that publication still uses the tested tarball.
19. Verify the published tarball against the pre-publication digest and signed provenance subject digest.

## Verification record

The original audit reported:

- `npx tsgo --noEmit` passed.
- Documentation lifecycle validation passed.
- Biome completed with one fixable informational suggestion.
- `npm audit --omit=dev` passed with zero known production vulnerabilities.
- Linux sandbox tests passed, with 19 tests reported.
- The full sandbox suite passed with 229 tests and 8 skips.
- Focused permission tests passed with 120 tests.
- Focused workflow and release tests passed with 26 tests.
- The full npm test run exited 1 with 3,427 passes, 58 skips, and two startup-session failures.
- The isolated startup-session test later passed with two tests.

The broad run is not green. The isolated rerun does not change that conclusion.

The follow-up review also recorded 22 offline workflow and release tests passing. It did not run provider turns, use live credentials, install a package, or publish a release.

No application source was changed during this review.

## Related evidence

- `.apex-code/audit-2026-09-03/report.md`
- `.apex-code/audit-2026-09-03/permissions.md`
- `.apex-code/audit-2026-09-03/sandbox.md`
- `.apex-code/audit-2026-09-03/execution-wiring.md`
- `.apex-code/audit-2026-09-03/execution-ci.md`
- `.apex-code/audit-2026-09-03/public-comparison.md`
- `.apex-code/audit-2026-09-03/config-projection.md`
- `.apex-code/audit-review-2026-09-05/permissions-review.md`
- `.apex-code/audit-review-2026-09-05/sandbox-review.md`
- `.apex-code/audit-review-2026-09-05/execution-release-review.md`
- `.apex-code/audit-review-2026-09-05/market-review.md`
- `.apex-code/audit-review-2026-09-05/architecture-critique.md`

## Principles applied

- **Foundational Thinking.** The canonical operation model and supervisor-owned state are load-bearing because the failures come from duplicated authority.
- **Redesign from First Principles.** Project-controlled files should be untrusted by default across every loader.
- **Subtract Before You Add.** Remove duplicate launch classification and the second release authority before adding more policy features.
- **Laziness Protocol.** Rank small root fixes instead of proposing a new security framework.
- **Model the Domain.** Use discriminated operation and match-result variants instead of scattered conditionals.
- **Boundary Discipline.** Validate at CLI, RPC, credential, path, and policy boundaries, then keep internal execution on typed values.
- **Type System Discipline.** Use canonical branded paths and structured operations rather than passing raw strings through authorization.
- **Prove It Works.** Require public-entrypoint tests and exact artifact comparisons instead of relying on unit tests or registry metadata.
- **Build the Lever.** Build a reusable adversarial public-entrypoint suite and immutable-artifact release check.
- **Sequence Work into Verifiable Units.** End each repair with a focused security test before starting the next boundary change.
- **Guard the Context Window.** Route subsystem and market research into separate reports and keep the main conclusion focused on decisions.
- **Minimize Reader Load.** Group findings by root cause and authority domain.
- **Outcome-Oriented Execution.** Converge on one authorization and execution representation instead of preserving duplicated paths.

## Final recommendation

Keep investing in the Linux containment work and the broader Apex architecture. Do not release Apex Code as a security-oriented tool, or market it as a complete security boundary, until the public-boundary tests for startup, trust, MCP, verification, formatting, canonical path authorization, supervisor services, and release artifact identity pass.

The first repair should be architectural but small. Parse once, resolve trust before constructing runtime authority, and pass one canonical operation into both authorization and execution. Do not begin with a broad sandbox rewrite.
